import "server-only";
import { randomInt } from "node:crypto";
import { Types, type ClientSession } from "mongoose";
import type { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { withTransaction } from "@/lib/db/transaction";
import { notifyCleaners } from "@/modules/notifications/service";
import { autoBookingEmail } from "./emails";
import { Booking, type BookingDoc } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { Organization } from "@/lib/db/models/organization";
import { Payment } from "@/lib/db/models/payment";
import { Service } from "@/lib/db/models/service";
import { ServiceAddress } from "@/lib/db/models/service-address";
import { BLOCKING_BOOKING_STATUSES, type BookingStatus } from "@/lib/domain/constants";
import { googleMapsUrl } from "@/lib/domain/links";
import { escapeRegex, normalizeCity, OBJECT_ID_RE } from "@/lib/domain/normalize";
import { addDaysToKey, localDateKey, localDaysRange, localTimeKey, zonedLocalToUtc, type Disambiguation } from "@/lib/domain/zoned-time";
import { AppError, Errors } from "@/lib/http/errors";
import { recordActivity } from "@/modules/activities/service";
import { recordAudit } from "@/modules/audit/service";
import { cleanerForUser } from "@/modules/cleaners/service";
import { customFieldDefsFor, validateCustomFieldValues, visibleCustomFieldValues } from "@/modules/custom-fields/service";
import { draftAmountsSet, orgTax } from "@/modules/finance/charges";
import {
  bookingListQuery,
  calendarQuery,
  changeAddressSchema,
  createBookingSchema,
  MAX_CALENDAR_DAYS,
  EDITABLE_FIELDS,
  TRANSITIONS,
  transitionSchema,
  updateBookingSchema,
  type BookingAction,
} from "./schemas";

// ---------------------------------------------------------------------------
// Viewer context and access
// ---------------------------------------------------------------------------

/** Who is looking: office staff, or a cleaner limited to their own assignments. */
export type Viewer = { user: CurrentUser; office: boolean; cleanerId: Types.ObjectId | null };

export async function viewerFor(user: CurrentUser): Promise<Viewer> {
  if (user.permissions.has("bookings:read")) return { user, office: true, cleanerId: null };
  if (user.permissions.has("bookings:read_assigned")) {
    const c = await cleanerForUser(user);
    return { user, office: false, cleanerId: c?._id ?? null };
  }
  throw Errors.forbidden();
}

function isAssigned(viewer: Viewer, b: { assignedCleanerIds: Types.ObjectId[] }) {
  return Boolean(viewer.cleanerId && b.assignedCleanerIds.some((id) => id.equals(viewer.cleanerId!)));
}

async function orgSettings(organizationId: string | Types.ObjectId) {
  const org = await Organization.findById(organizationId).select("timezone currency scheduling").lean();
  if (!org) throw Errors.notFound("Organization");
  return { timezone: org.timezone, currency: org.currency, bufferMinutes: org.scheduling?.bufferMinutes ?? 0 };
}

// ---------------------------------------------------------------------------
// Time conversion
// ---------------------------------------------------------------------------

function resolveStart(date: string, time: string, tz: string, disambiguation?: Disambiguation): Date {
  const r = zonedLocalToUtc(date, time, tz, disambiguation);
  if (r.ok) return r.instant;
  if (r.reason === "NONEXISTENT") {
    throw new AppError(422, "NONEXISTENT_LOCAL_TIME", `${time} does not exist on ${date} in ${tz} because clocks move forward. Choose a different time.`, { fieldErrors: { startTime: ["This time is skipped by the daylight-saving change."] } });
  }
  if (r.reason === "AMBIGUOUS") {
    throw new AppError(422, "AMBIGUOUS_LOCAL_TIME", `${time} occurs twice on ${date} in ${tz} because clocks move back. Choose which one you mean.`, {
      options: { earlier: r.options.earlier.toISOString(), later: r.options.later.toISOString() },
    });
  }
  throw Errors.validation("Choose a valid date and time.");
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Random human reference, e.g. RP-261015-7KQ4M. Never derived from document counts. */
export function generateReference(start: Date, tz: string): string {
  const day = localDateKey(start, tz).slice(2).replace(/-/g, "");
  let suffix = "";
  for (let i = 0; i < 5; i++) suffix += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `RP-${day}-${suffix}`;
}

async function uniqueReference(organizationId: Types.ObjectId, start: Date, tz: string, session: ClientSession) {
  for (let i = 0; i < 5; i++) {
    const ref = generateReference(start, tz);
    if (!(await Booking.exists({ organizationId, reference: ref }).session(session))) return ref;
  }
  throw new AppError(500, "REFERENCE_EXHAUSTED", "Could not allocate a booking reference. Please retry.");
}

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

type LineInput = { lineItemId?: string; serviceId: string; quantity: number; unitPriceCents?: number };
type StoredLine = {
  _id: Types.ObjectId;
  serviceId: Types.ObjectId;
  name: string;
  unitLabel: string;
  quantity: number;
  unitPriceCents: number;
  catalogUnitPriceCents: number;
  durationMinutes: number;
  lineTotalCents: number;
};

/**
 * Server-side line building. New items snapshot the active catalog service.
 * Existing items (by lineItemId) keep their snapshot and id. Prices are
 * catalog prices unless the user may override; totals are always computed here.
 */
async function buildLineItems(
  viewer: Viewer,
  orgId: Types.ObjectId,
  inputs: LineInput[],
  existing: StoredLine[],
  session?: ClientSession,
): Promise<{ lines: StoredLine[]; overrides: { name: string; from: number; to: number }[]; removed: StoredLine[] }> {
  const canPrice = viewer.user.permissions.has("pricing:read");
  const canOverride = canPrice && viewer.user.permissions.has("bookings:price_override");
  const existingById = new Map(existing.map((l) => [String(l._id), l]));
  const newServiceIds = [...new Set(inputs.filter((i) => !i.lineItemId).map((i) => i.serviceId))];
  const services = newServiceIds.length
    ? await Service.find({ _id: { $in: newServiceIds }, organizationId: orgId }).session(session ?? null).lean()
    : [];
  const serviceById = new Map(services.map((s) => [String(s._id), s]));
  const overrides: { name: string; from: number; to: number }[] = [];
  const seenIds = new Set<string>();

  const lines = inputs.map((input, index): StoredLine => {
    if (input.unitPriceCents !== undefined && !canPrice) throw Errors.forbidden("You can't set prices.");
    if (input.lineItemId) {
      const prev = existingById.get(input.lineItemId);
      if (!prev || seenIds.has(input.lineItemId)) throw Errors.validation(`Service item ${index + 1} is not part of this booking.`);
      seenIds.add(input.lineItemId);
      if (String(prev.serviceId) !== input.serviceId) throw Errors.validation("An existing item's service can't be changed; remove it and add a new one.");
      const unit = input.unitPriceCents ?? prev.unitPriceCents;
      if (unit !== prev.unitPriceCents) {
        if (!canOverride) throw Errors.forbidden("You don't have permission to change prices.");
        overrides.push({ name: prev.name, from: prev.unitPriceCents, to: unit });
      }
      return { ...prev, quantity: input.quantity, unitPriceCents: unit, lineTotalCents: input.quantity * unit };
    }
    const svc = serviceById.get(input.serviceId);
    if (!svc) throw Errors.validation(`Service item ${index + 1}: service not found.`);
    if (!svc.active) throw Errors.validation(`"${svc.name}" is inactive and can't be added to a booking.`, { [`lineItems.${index}.serviceId`]: ["Inactive service"] });
    const unit = input.unitPriceCents ?? svc.defaultPriceCents;
    if (unit !== svc.defaultPriceCents) {
      if (!canOverride) throw Errors.forbidden("You don't have permission to change prices.");
      overrides.push({ name: svc.name, from: svc.defaultPriceCents, to: unit });
    }
    return {
      _id: new Types.ObjectId(),
      serviceId: svc._id,
      name: svc.name,
      unitLabel: svc.unitLabel ?? "item",
      quantity: input.quantity,
      unitPriceCents: unit,
      catalogUnitPriceCents: svc.defaultPriceCents,
      durationMinutes: svc.durationMinutes,
      lineTotalCents: input.quantity * unit,
    };
  });
  const removed = existing.filter((l) => !seenIds.has(String(l._id)));
  return { lines, overrides, removed };
}

// ---------------------------------------------------------------------------
// Scheduling lock and conflicts
// ---------------------------------------------------------------------------

export type ScheduleConflict = { cleanerId: string; cleanerName: string; bookingId: string; reference: string; start: string; end: string };

/**
 * Concurrency-safe availability check, run INSIDE a transaction:
 *  1. Lock: increment each cleaner's `scheduleRevision` (also verifies the
 *     cleaner is active, unarchived and in this org). Two transactions
 *     assigning the same cleaner both write that document, so MongoDB aborts
 *     one with a write conflict; it is retried and then sees the other's booking.
 *  2. Overlap query: newStart < existingEnd AND newEnd > existingStart (with
 *     the org buffer), ignoring cancelled/completed jobs and the booking itself.
 */
async function lockAndCheckCleaners(
  session: ClientSession,
  orgId: Types.ObjectId,
  cleanerIds: Types.ObjectId[],
  start: Date,
  end: Date,
  bufferMinutes: number,
  excludeBookingId: Types.ObjectId | null,
  requireActive: Set<string>,
) {
  if (cleanerIds.length === 0) return;
  const names = new Map<string, string>();
  for (const id of [...cleanerIds].sort((a, b) => String(a).localeCompare(String(b)))) {
    const mustBeActive = requireActive.has(String(id));
    const locked = await Cleaner.findOneAndUpdate(
      { _id: id, organizationId: orgId, ...(mustBeActive ? { active: true, archivedAt: null } : {}) },
      { $inc: { scheduleRevision: 1 } },
      { session, returnDocument: "after", projection: { name: 1 } },
    ).lean();
    if (!locked) throw new AppError(409, "CLEANER_UNAVAILABLE", "One of the selected cleaners is inactive or no longer exists. Choose another cleaner.");
    names.set(String(id), locked.name);
  }
  const bufferMs = bufferMinutes * 60_000;
  const conflicts = await Booking.find({
    organizationId: orgId,
    assignedCleanerIds: { $in: cleanerIds },
    status: { $in: BLOCKING_BOOKING_STATUSES },
    scheduledStartAt: { $lt: new Date(end.getTime() + bufferMs) },
    scheduledEndAt: { $gt: new Date(start.getTime() - bufferMs) },
    ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
  })
    .select("reference scheduledStartAt scheduledEndAt assignedCleanerIds")
    .limit(20)
    .session(session)
    .lean();
  if (conflicts.length > 0) {
    const details: ScheduleConflict[] = conflicts.flatMap((b) =>
      b.assignedCleanerIds
        .filter((cid) => cleanerIds.some((x) => x.equals(cid)))
        .map((cid) => ({
          cleanerId: String(cid),
          cleanerName: names.get(String(cid)) ?? "Cleaner",
          bookingId: String(b._id),
          reference: b.reference,
          start: b.scheduledStartAt.toISOString(),
          end: b.scheduledEndAt.toISOString(),
        })),
    );
    throw new AppError(409, "SCHEDULE_CONFLICT", "A selected cleaner already has a job at that time.", { conflicts: details });
  }
}

function uniqueIds(ids: string[]): Types.ObjectId[] {
  return [...new Set(ids)].map((id) => new Types.ObjectId(id));
}

async function loadCustomerAndAddress(orgId: Types.ObjectId, customerId: string, addressId: string, session?: ClientSession) {
  const customer = await Customer.findOne({ _id: customerId, organizationId: orgId }).select("name archivedAt").session(session ?? null).lean();
  if (!customer) throw Errors.notFound("Customer");
  if (customer.archivedAt) throw Errors.validation("This customer is archived. Restore them before booking.");
  const address = await ServiceAddress.findOne({ _id: addressId, organizationId: orgId, customerId: customer._id, archivedAt: null }).session(session ?? null).lean();
  if (!address) throw Errors.validation("Choose one of this customer's current service addresses.", { addressId: ["Address not found for this customer"] });
  return { customer, address };
}

function snapshotOf(a: { label?: string | null; line1: string; line2?: string | null; city: string; region?: string | null; postalCode?: string | null; country?: string | null; location?: { lat: number; lng: number } | null; accessInstructions?: string | null }) {
  return {
    label: a.label ?? "",
    line1: a.line1,
    line2: a.line2 ?? "",
    city: a.city,
    cityNormalized: normalizeCity(a.city),
    region: a.region ?? "",
    postalCode: a.postalCode ?? "",
    country: a.country ?? "",
    location: a.location && typeof a.location.lat === "number" ? { lat: a.location.lat, lng: a.location.lng } : null,
    accessInstructions: a.accessInstructions ?? "",
  };
}

// ---------------------------------------------------------------------------
// DTO shaping (field-level restrictions)
// ---------------------------------------------------------------------------

export type BookingDTO = {
  id: string;
  reference: string;
  status: BookingStatus;
  version: number;
  customer: { id: string; name: string; phone: string | null; phoneDisplay: string | null; email: string | null; profileAccessible: boolean };
  scheduledStartAt: string;
  scheduledEndAt: string;
  durationMinutes: number;
  timezone: string;
  local: { date: string; startTime: string; endTime: string; endDate: string };
  address: { label: string; line1: string; line2: string; city: string; region: string; postalCode: string; country: string; accessInstructions: string; mapUrl: string | null; addressId: string | null };
  lineItems: { id: string; serviceId: string; name: string; unitLabel: string; quantity: number; durationMinutes: number; unitPriceCents: number | null; lineTotalCents: number | null; catalogUnitPriceCents: number | null }[];
  subtotalCents: number | null;
  currency: string;
  /** Billing data: amounts need pricing:read; paid/balance additionally need financials:read. Null for cleaners. */
  billing: BookingBilling | null;
  customFields: Record<string, unknown>;
  cleaners: { id: string; name: string; phone: string | null; phoneDisplay: string | null; active: boolean }[];
  instructions: string;
  officeNotes: string | null;
  actualStartedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  allowedActions: BookingAction[];
  editable: string[];
};

export type BookingBilling = {
  state: "DRAFT" | "FINALIZED";
  discount: { type: "none" | "fixed" | "percent"; amountCents: number; basisPoints: number };
  tax: { enabled: boolean; rateBasisPoints: number; label: string };
  grossCents: number;
  discountCents: number;
  netCents: number;
  taxCents: number;
  chargedCents: number;
  adjustmentsCents: number;
  paidCents: number | null;
  balanceCents: number | null;
  finalizedAt: string | null;
  lines: { lineItemId: string; name: string; grossCents: number; discountCents: number; netCents: number; taxCents: number; chargedCents: number; adjustmentCents: number; paidCents: number | null; balanceCents: number | null }[];
};

function billingOf(b: BookingDoc, canMoney: boolean): BookingBilling {
  const finalized = b.billingState === "FINALIZED";
  return {
    state: (b.billingState ?? "DRAFT") as "DRAFT" | "FINALIZED",
    discount: { type: (b.discount?.type ?? "none") as "none" | "fixed" | "percent", amountCents: b.discount?.amountCents ?? 0, basisPoints: b.discount?.basisPoints ?? 0 },
    tax: { enabled: Boolean(b.tax?.enabled), rateBasisPoints: b.tax?.rateBasisPoints ?? 0, label: b.tax?.label ?? "" },
    grossCents: b.subtotalCents,
    discountCents: b.discountCents ?? 0,
    netCents: b.netCents ?? 0,
    taxCents: b.taxCents ?? 0,
    chargedCents: b.chargedCents ?? 0,
    adjustmentsCents: b.adjustmentsCents ?? 0,
    paidCents: canMoney ? (b.allocatedCents ?? 0) : null,
    balanceCents: canMoney && finalized ? (b.chargedCents ?? 0) + (b.adjustmentsCents ?? 0) - (b.allocatedCents ?? 0) : null,
    finalizedAt: b.finalizedAt ? b.finalizedAt.toISOString() : null,
    lines: b.lineItems.map((l) => ({
      lineItemId: String(l._id),
      name: l.name,
      grossCents: l.lineTotalCents,
      discountCents: l.discountCents ?? 0,
      netCents: l.netCents ?? 0,
      taxCents: l.taxCents ?? 0,
      chargedCents: l.chargedCents ?? 0,
      adjustmentCents: l.adjustmentCents ?? 0,
      paidCents: canMoney ? (l.allocatedCents ?? 0) : null,
      balanceCents: canMoney && finalized ? (l.chargedCents ?? 0) + (l.adjustmentCents ?? 0) - (l.allocatedCents ?? 0) : null,
    })),
  };
}

function allowedActionsFor(viewer: Viewer, b: { status: string; assignedCleanerIds: Types.ObjectId[] }): BookingAction[] {
  const p = viewer.user.permissions;
  const status = b.status as BookingStatus;
  const canOperate = p.has("bookings:write") || (p.has("bookings:transition_assigned") && isAssigned(viewer, b));
  return (Object.keys(TRANSITIONS) as BookingAction[]).filter((action) => {
    if (!TRANSITIONS[action].from.includes(status)) return false;
    if (action === "start" || action === "complete") return canOperate;
    if (action === "cancel") return p.has("bookings:write");
    if (action === "reopen") return p.has("bookings:reopen");
    return false;
  });
}

async function shapeBookings(viewer: Viewer, rows: BookingDoc[]): Promise<BookingDTO[]> {
  const orgId = viewer.user.organizationId;
  const customerIds = [...new Set(rows.map((r) => String(r.customerId)))];
  const cleanerIds = [...new Set(rows.flatMap((r) => r.assignedCleanerIds.map(String)))];
  const [customers, cleaners] = await Promise.all([
    Customer.find({ _id: { $in: customerIds }, organizationId: orgId }).select("name phone phoneDisplay email").lean(),
    cleanerIds.length ? Cleaner.find({ _id: { $in: cleanerIds }, organizationId: orgId }).select("name phone phoneDisplay active archivedAt").lean() : [],
  ]);
  const customerById = new Map(customers.map((c) => [String(c._id), c]));
  const cleanerById = new Map(cleaners.map((c) => [String(c._id), c]));
  const p = viewer.user.permissions;
  const canPrice = viewer.office && p.has("pricing:read");
  const canMoney = canPrice && p.has("financials:read");
  const profileAccessible = viewer.office && p.has("customers:read");
  const cfDefs = await customFieldDefsFor(viewer.user.organizationId, "booking");

  return rows.map((b) => {
    const tz = b.timezone;
    const c = customerById.get(String(b.customerId));
    const a = b.addressSnapshot;
    return {
      id: String(b._id),
      reference: b.reference,
      status: b.status as BookingStatus,
      version: b.version,
      customer: {
        id: String(b.customerId),
        name: c?.name ?? "Unknown customer",
        phone: c?.phone ?? null,
        phoneDisplay: c?.phoneDisplay ?? c?.phone ?? null,
        email: c?.email ?? null,
        profileAccessible,
      },
      scheduledStartAt: b.scheduledStartAt.toISOString(),
      scheduledEndAt: b.scheduledEndAt.toISOString(),
      durationMinutes: Math.round((b.scheduledEndAt.getTime() - b.scheduledStartAt.getTime()) / 60_000),
      timezone: tz,
      local: {
        date: localDateKey(b.scheduledStartAt, tz),
        startTime: localTimeKey(b.scheduledStartAt, tz),
        endTime: localTimeKey(b.scheduledEndAt, tz),
        endDate: localDateKey(b.scheduledEndAt, tz),
      },
      address: {
        label: a.label ?? "",
        line1: a.line1,
        line2: a.line2 ?? "",
        city: a.city,
        region: a.region ?? "",
        postalCode: a.postalCode ?? "",
        country: a.country ?? "",
        // Office staff and the assigned cleaner need access/parking details for the job.
        accessInstructions: a.accessInstructions ?? "",
        mapUrl: googleMapsUrl(a),
        addressId: viewer.office && b.serviceAddressId ? String(b.serviceAddressId) : null,
      },
      lineItems: b.lineItems.map((l) => ({
        id: String(l._id),
        serviceId: String(l.serviceId),
        name: l.name,
        unitLabel: l.unitLabel ?? "item",
        quantity: l.quantity,
        durationMinutes: l.durationMinutes,
        unitPriceCents: canPrice ? l.unitPriceCents : null,
        lineTotalCents: canPrice ? l.lineTotalCents : null,
        catalogUnitPriceCents: canPrice ? l.catalogUnitPriceCents : null,
      })),
      subtotalCents: canPrice ? b.subtotalCents : null,
      currency: b.currency,
      billing: canPrice ? billingOf(b, canMoney) : null,
      customFields: visibleCustomFieldValues(cfDefs, b.customFields, viewer.office ? "office" : "assigned_cleaners"),
      cleaners: b.assignedCleanerIds.map((id) => {
        const x = cleanerById.get(String(id));
        return { id: String(id), name: x?.name ?? "Former cleaner", phone: x?.phone ?? null, phoneDisplay: x?.phoneDisplay ?? x?.phone ?? null, active: Boolean(x?.active && !x.archivedAt) };
      }),
      instructions: b.instructions ?? "",
      officeNotes: viewer.office ? (b.officeNotes ?? "") : null,
      actualStartedAt: b.actualStartedAt ? b.actualStartedAt.toISOString() : null,
      completedAt: b.completedAt ? b.completedAt.toISOString() : null,
      cancelledAt: b.cancelledAt ? b.cancelledAt.toISOString() : null,
      cancellationReason: viewer.office ? (b.cancellationReason ?? "") : null,
      allowedActions: allowedActionsFor(viewer, b),
      // Finalized charges are locked: corrections go through charge adjustments.
      editable: viewer.office && p.has("bookings:write") ? EDITABLE_FIELDS[b.status as BookingStatus].filter((f) => !(f === "lineItems" && b.billingState === "FINALIZED")) : [],
    };
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadVisibleBooking(viewer: Viewer, id: string, session?: ClientSession) {
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Booking");
  const b = await Booking.findOne({ _id: id, organizationId: viewer.user.organizationId }).session(session ?? null).lean();
  // Cleaners can only see their own assignments; others are indistinguishable from missing.
  if (!b || (!viewer.office && !isAssigned(viewer, b))) throw Errors.notFound("Booking");
  return b as BookingDoc;
}

export async function getBooking(user: CurrentUser, id: string): Promise<BookingDTO> {
  await connectDb();
  const viewer = await viewerFor(user);
  const b = await loadVisibleBooking(viewer, id);
  return (await shapeBookings(viewer, [b]))[0]!;
}

export async function listBookings(user: CurrentUser, q: z.infer<typeof bookingListQuery>) {
  await connectDb();
  const viewer = await viewerFor(user);
  const { timezone } = await orgSettings(user.organizationId);
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(user.organizationId) };
  if (!viewer.office) {
    if (!viewer.cleanerId) return { items: [], page: 1, pageSize: q.pageSize, total: 0, totalPages: 1 };
    filter.assignedCleanerIds = viewer.cleanerId;
  } else {
    if (q.cleanerId) filter.assignedCleanerIds = new Types.ObjectId(q.cleanerId);
    if (q.unassigned) filter.assignedCleanerIds = { $size: 0 };
    if (q.customerId) filter.customerId = new Types.ObjectId(q.customerId);
    if (q.city) filter["addressSnapshot.cityNormalized"] = normalizeCity(q.city);
    if (q.q) filter.reference = { $regex: `^${escapeRegex(q.q.toUpperCase())}` };
  }
  if (q.status) filter.status = q.status;
  if (q.from || q.to) {
    const range = localDaysRange(q.from ?? q.to!, q.to ?? q.from!, timezone);
    filter.scheduledStartAt = { $gte: range.start, $lt: range.end };
  }
  const dir = q.dir === "asc" ? 1 : -1;
  const [total, rows] = await Promise.all([
    Booking.countDocuments(filter),
    Booking.find(filter).sort({ scheduledStartAt: dir, _id: dir }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
  ]);
  return { items: await shapeBookings(viewer, rows as BookingDoc[]), page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createBooking(user: CurrentUser, raw: unknown): Promise<{ booking: BookingDTO; created: boolean }> {
  if (!user.permissions.has("bookings:write")) throw Errors.forbidden();
  const input = createBookingSchema.parse(raw);
  await connectDb();
  const viewer: Viewer = { user, office: true, cleanerId: null };
  const orgId = new Types.ObjectId(user.organizationId);

  const findExisting = async () => Booking.findOne({ organizationId: orgId, idempotencyKey: input.idempotencyKey }).lean();
  const replay = await findExisting();
  if (replay) return { booking: (await shapeBookings(viewer, [replay as BookingDoc]))[0]!, created: false };

  const settings = await orgSettings(orgId);
  const start = resolveStart(input.date, input.startTime, settings.timezone, input.disambiguation);
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);
  if (input.status === "COMPLETED" && start > new Date()) throw Errors.validation("Only past jobs can be recorded as completed.");
  const cleanerIds = uniqueIds(input.cleanerIds);

  let bookingId: Types.ObjectId;
  try {
    bookingId = await withTransaction(async (session) => {
      const { customer, address } = await loadCustomerAndAddress(orgId, input.customerId, input.addressId, session);
      const { lines, overrides } = await buildLineItems(viewer, orgId, input.lineItems, [], session);
      if (input.status === "SCHEDULED") {
        await lockAndCheckCleaners(session, orgId, cleanerIds, start, end, settings.bufferMinutes, null, new Set(cleanerIds.map(String)));
      } else if (cleanerIds.length) {
        // Recording a past job: cleaners must belong to the org, but don't block on history.
        const n = await Cleaner.countDocuments({ _id: { $in: cleanerIds }, organizationId: orgId }).session(session);
        if (n !== cleanerIds.length) throw Errors.validation("One of the selected cleaners was not found.");
      }
      const reference = await uniqueReference(orgId, start, settings.timezone, session);
      const [doc] = await Booking.create(
        [
          {
            organizationId: orgId,
            reference,
            customerId: customer._id,
            serviceAddressId: address._id,
            assignedCleanerIds: cleanerIds,
            scheduledStartAt: start,
            scheduledEndAt: end,
            timezone: settings.timezone,
            status: input.status,
            instructions: input.instructions,
            officeNotes: input.officeNotes,
            addressSnapshot: snapshotOf(address),
            lineItems: lines,
            currency: settings.currency,
            subtotalCents: 0, // recomputed in pre-validate
            billingState: "DRAFT",
            // Draft amounts preview the organization's current tax setting; frozen only at finalization.
            tax: await orgTax(orgId),
            customFields: await validateCustomFieldValues(orgId, "booking", input.customFields, {}, "create"),
            completedAt: input.status === "COMPLETED" ? end : null,
            idempotencyKey: input.idempotencyKey,
            createdBy: user.id,
          },
        ],
        { session },
      );
      await recordActivity(
        {
          organizationId: orgId,
          actorId: user.id,
          type: "booking.created",
          customerId: customer._id,
          bookingId: doc!._id,
          metadata: { reference, status: input.status, cleaners: cleanerIds.length },
          dedupeKey: `booking.created:${input.idempotencyKey}`,
        },
        session,
      );
      if (input.status === "SCHEDULED") {
        await notifyCleaners(session, "assignment_added", cleanerIds, { organizationId: orgId, bookingId: doc!._id, reference, start, timezone: settings.timezone, city: address.city ?? "", changeKey: "v0" });
      }
      if (overrides.length) {
        await recordAudit({
          organizationId: orgId,
          actorId: user.id,
          action: "booking.price_overridden",
          entityType: "booking",
          entityId: doc!._id,
          metadata: { reference, items: overrides.map((o) => `${o.name}: ${o.from} → ${o.to}`) },
        });
      }
      return doc!._id;
    });
  } catch (err) {
    // Concurrent retry with the same idempotency key: return the booking that won.
    if ((err as { code?: number; keyPattern?: Record<string, unknown> }).code === 11000) {
      const existing = await findExisting();
      if (existing) return { booking: (await shapeBookings(viewer, [existing as BookingDoc]))[0]!, created: false };
    }
    throw err;
  }
  const fresh = await Booking.findById(bookingId).lean();
  if (input.status === "SCHEDULED") await autoBookingEmail(orgId, String(bookingId), "booking_confirmation", "v0");
  return { booking: (await shapeBookings(viewer, [fresh as BookingDoc]))[0]!, created: true };
}

// ---------------------------------------------------------------------------
// Update (optimistic concurrency)
// ---------------------------------------------------------------------------

function staleError() {
  return new AppError(409, "STALE_VERSION", "Someone else changed this booking since you opened it. Reload to see their changes, then try again.");
}

export async function updateBooking(user: CurrentUser, id: string, raw: unknown): Promise<BookingDTO> {
  if (!user.permissions.has("bookings:write")) throw Errors.forbidden();
  const input = updateBookingSchema.parse(raw);
  await connectDb();
  const viewer: Viewer = { user, office: true, cleanerId: null };
  const orgId = new Types.ObjectId(user.organizationId);
  const settings = await orgSettings(orgId);

  let emailChange: string | null = null;
  await withTransaction(async (session) => {
    emailChange = null;
    const b = await loadVisibleBooking(viewer, id, session);
    if (b.version !== input.expectedVersion) throw staleError();
    const status = b.status as BookingStatus;
    const editable = EDITABLE_FIELDS[status];
    const wants = {
      schedule: input.date !== undefined,
      lineItems: input.lineItems !== undefined,
      cleaners: input.cleanerIds !== undefined,
      instructions: input.instructions !== undefined,
      officeNotes: input.officeNotes !== undefined,
    };
    for (const [field, requested] of Object.entries(wants)) {
      if (requested && !editable.includes(field as (typeof editable)[number])) {
        throw new AppError(409, "NOT_EDITABLE", status === "COMPLETED" ? "Completed jobs are locked. Reopen the job (authorized users only) to correct it." : `This can't be changed while the booking is ${status.toLowerCase().replace("_", " ")}.`, { field });
      }
    }

    const set: Record<string, unknown> = {};
    const activities: Parameters<typeof recordActivity>[0][] = [];
    let start = b.scheduledStartAt;
    let end = b.scheduledEndAt;
    if (wants.schedule) {
      start = resolveStart(input.date!, input.startTime!, settings.timezone, input.disambiguation);
      end = new Date(start.getTime() + input.durationMinutes! * 60_000);
      if (start.getTime() !== b.scheduledStartAt.getTime() || end.getTime() !== b.scheduledEndAt.getTime()) {
        set.scheduledStartAt = start;
        set.scheduledEndAt = end;
        activities.push({
          organizationId: orgId,
          actorId: user.id,
          type: "booking.rescheduled",
          customerId: b.customerId,
          bookingId: b._id,
          metadata: { from: b.scheduledStartAt.toISOString(), to: start.toISOString() },
        });
      }
    }

    if (wants.lineItems) {
      const { lines, overrides, removed } = await buildLineItems(viewer, orgId, input.lineItems!, b.lineItems as StoredLine[], session);
      if (removed.length) {
        const allocated = await Payment.exists({ organizationId: orgId, "allocations.lineItemId": { $in: removed.map((r) => r._id) } }).session(session);
        if (allocated) throw new AppError(409, "LINE_ITEM_HAS_PAYMENTS", "A removed service item already has payments allocated to it. Adjust the payment first.");
      }
      if (b.billingState === "FINALIZED") throw new AppError(409, "FINALIZED_CHARGES", "Charges are finalized and can't be edited. Use a charge adjustment (credit or extra charge) instead.");
      // Draft amounts: recompute discount allocation and tax preview for the new lines.
      const discount = { type: (b.discount?.type ?? "none") as "none" | "fixed" | "percent", amountCents: b.discount?.amountCents ?? 0, basisPoints: b.discount?.basisPoints ?? 0 };
      const tax = await orgTax(orgId);
      const { amounts, totals } = draftAmountsSet(lines, discount, tax);
      set.lineItems = lines.map((l, i) => ({ ...l, ...amounts[i], adjustmentCents: 0, allocatedCents: 0 }));
      set.subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
      Object.assign(set, { tax, discountCents: totals.discountCents, netCents: totals.netCents, taxCents: totals.taxCents, chargedCents: totals.chargedCents });
      activities.push({ organizationId: orgId, actorId: user.id, type: "booking.updated", customerId: b.customerId, bookingId: b._id, metadata: { fields: ["services"] } });
      if (overrides.length) {
        await recordAudit({ organizationId: orgId, actorId: user.id, action: "booking.price_overridden", entityType: "booking", entityId: b._id, metadata: { reference: b.reference, items: overrides.map((o) => `${o.name}: ${o.from} → ${o.to}`) } });
      }
    }

    let cleanerIds = b.assignedCleanerIds as Types.ObjectId[];
    if (wants.cleaners) {
      const next = uniqueIds(input.cleanerIds!);
      const added = next.filter((n) => !cleanerIds.some((c) => c.equals(n)));
      const removedC = cleanerIds.filter((c) => !next.some((n) => n.equals(c)));
      if (added.length || removedC.length) {
        set.assignedCleanerIds = next;
        activities.push({
          organizationId: orgId,
          actorId: user.id,
          type: "booking.assignment_changed",
          customerId: b.customerId,
          bookingId: b._id,
          metadata: { added: added.map(String), removed: removedC.map(String) },
        });
      }
      cleanerIds = next;
    }

    // Re-check availability whenever time or assignment changed. Newly added
    // cleaners must be active; kept ones are still locked so moves serialize.
    if ((set.scheduledStartAt || set.assignedCleanerIds) && BLOCKING_BOOKING_STATUSES.includes(status as never)) {
      const newlyAdded = new Set(cleanerIds.filter((c) => !(b.assignedCleanerIds as Types.ObjectId[]).some((x) => x.equals(c))).map(String));
      const mustBeActive = set.scheduledStartAt ? new Set(cleanerIds.map(String)) : newlyAdded;
      await lockAndCheckCleaners(session, orgId, cleanerIds, start, end, settings.bufferMinutes, b._id, mustBeActive);
    }

    if (input.customFields !== undefined) {
      set.customFields = await validateCustomFieldValues(orgId, "booking", input.customFields, (b.customFields ?? {}) as Record<string, unknown>, "update");
    }
    if (wants.instructions && input.instructions !== b.instructions) set.instructions = input.instructions;
    if (wants.officeNotes && input.officeNotes !== b.officeNotes) set.officeNotes = input.officeNotes;
    if ((set.instructions !== undefined || set.officeNotes !== undefined || set.customFields !== undefined) && !activities.some((a) => a.type === "booking.updated")) {
      activities.push({ organizationId: orgId, actorId: user.id, type: "booking.updated", customerId: b.customerId, bookingId: b._id, metadata: { fields: ["notes"] } });
    }
    if (Object.keys(set).length === 0) return;

    const res = await Booking.updateOne({ _id: b._id, organizationId: orgId, version: input.expectedVersion }, { $set: set, $inc: { version: 1 } }, { session });
    if (res.matchedCount === 0) throw staleError();
    for (const a of activities) await recordActivity(a, session);

    // In-app notices to the cleaners concerned (only people entitled to the job).
    const notice = { organizationId: orgId, bookingId: b._id, reference: b.reference, start, timezone: settings.timezone, city: b.addressSnapshot?.city ?? "", changeKey: `v${input.expectedVersion + 1}` };
    const before = b.assignedCleanerIds as Types.ObjectId[];
    const added = cleanerIds.filter((c) => !before.some((x) => x.equals(c)));
    const removed = before.filter((c) => !cleanerIds.some((x) => x.equals(c)));
    if (added.length) await notifyCleaners(session, "assignment_added", added, notice);
    if (removed.length) await notifyCleaners(session, "assignment_removed", removed, notice);
    if (set.scheduledStartAt) {
      await notifyCleaners(session, "booking_rescheduled", cleanerIds.filter((c) => !added.some((x) => x.equals(c))), notice);
      emailChange = notice.changeKey;
    }
  });
  if (emailChange) await autoBookingEmail(orgId, id, "booking_changed", emailChange);
  return getBooking(user, id);
}

/**
 * Explicitly moves a future booking to another (or refreshed) address of the
 * same customer. Audited and recorded in the booking's history.
 */
export async function changeBookingAddress(user: CurrentUser, id: string, raw: unknown) {
  if (!user.permissions.has("bookings:write")) throw Errors.forbidden();
  const input = changeAddressSchema.parse(raw);
  await connectDb();
  const viewer: Viewer = { user, office: true, cleanerId: null };
  const orgId = new Types.ObjectId(user.organizationId);
  await withTransaction(async (session) => {
    const b = await loadVisibleBooking(viewer, id, session);
    if (b.version !== input.expectedVersion) throw staleError();
    if (b.status !== "SCHEDULED" || b.scheduledStartAt <= new Date()) {
      throw new AppError(409, "NOT_EDITABLE", "Only future scheduled bookings can change address; past jobs keep the address they were done at.");
    }
    const address = await ServiceAddress.findOne({ _id: input.addressId, organizationId: orgId, customerId: b.customerId, archivedAt: null }).session(session).lean();
    if (!address) throw Errors.validation("Choose one of this customer's current addresses.");
    const res = await Booking.updateOne(
      { _id: b._id, version: input.expectedVersion },
      { $set: { serviceAddressId: address._id, addressSnapshot: snapshotOf(address) }, $inc: { version: 1 } },
      { session },
    );
    if (res.matchedCount === 0) throw staleError();
    const meta = { from: `${b.addressSnapshot.line1}, ${b.addressSnapshot.city}`, to: `${address.line1}, ${address.city}` };
    await recordActivity({ organizationId: orgId, actorId: user.id, type: "booking.address_changed", customerId: b.customerId, bookingId: b._id, metadata: meta }, session);
    await recordAudit({ organizationId: orgId, actorId: user.id, action: "booking.address_changed", entityType: "booking", entityId: b._id, metadata: { reference: b.reference } });
  });
  await autoBookingEmail(orgId, id, "booking_changed", `addr-v${input.expectedVersion + 1}`);
  return getBooking(user, id);
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

export async function transitionBooking(user: CurrentUser, id: string, raw: unknown): Promise<BookingDTO> {
  const input = transitionSchema.parse(raw);
  await connectDb();
  const viewer = await viewerFor(user);
  const orgId = new Types.ObjectId(user.organizationId);
  const settings = await orgSettings(orgId);
  await withTransaction(async (session) => {
    const b = await loadVisibleBooking(viewer, id, session);
    if (!allowedActionsFor(viewer, b).includes(input.action)) {
      if (!TRANSITIONS[input.action].from.includes(b.status as BookingStatus)) {
        throw new AppError(409, "INVALID_TRANSITION", `A ${b.status.toLowerCase().replace("_", " ")} booking can't be ${input.action === "start" ? "started" : input.action + "d"}.`);
      }
      throw Errors.forbidden();
    }
    if (b.version !== input.expectedVersion) throw staleError();
    const now = new Date();
    const set: Record<string, unknown> = { status: TRANSITIONS[input.action].to };
    if (input.action === "start") set.actualStartedAt = now;
    if (input.action === "complete") set.completedAt = now;
    if (input.action === "cancel") Object.assign(set, { cancelledAt: now, cancellationReason: input.reason });
    if (input.action === "reopen") {
      set.completedAt = null;
      // Reopened work occupies the cleaners again, so it must not create a double booking.
      await lockAndCheckCleaners(session, orgId, b.assignedCleanerIds as Types.ObjectId[], b.scheduledStartAt, b.scheduledEndAt, settings.bufferMinutes, b._id, new Set());
    }
    const res = await Booking.updateOne({ _id: b._id, version: input.expectedVersion, status: b.status }, { $set: set, $inc: { version: 1 } }, { session });
    if (res.matchedCount === 0) throw staleError();
    const type = ({ start: "booking.started", complete: "booking.completed", cancel: "booking.cancelled", reopen: "booking.reopened" } as const)[input.action];
    await recordActivity({ organizationId: orgId, actorId: user.id, type, customerId: b.customerId, bookingId: b._id, content: input.reason, metadata: { reference: b.reference } }, session);
    if (input.action === "cancel") {
      await notifyCleaners(session, "booking_cancelled", b.assignedCleanerIds as Types.ObjectId[], { organizationId: orgId, bookingId: b._id, reference: b.reference, start: b.scheduledStartAt, timezone: settings.timezone, city: b.addressSnapshot?.city ?? "", changeKey: `v${input.expectedVersion + 1}` });
    }
    if (input.action === "reopen" || input.action === "cancel") {
      await recordAudit({ organizationId: orgId, actorId: user.id, action: `booking.${input.action === "reopen" ? "reopened" : "cancelled"}`, entityType: "booking", entityId: b._id, metadata: { reference: b.reference } });
    }
  });
  // Cancelling never deletes or refunds payments; they stay allocated until refunded explicitly.
  if (input.action === "cancel") await autoBookingEmail(orgId, id, "booking_cancelled", `v${input.expectedVersion + 1}`);
  return getBooking(user, id);
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export type CalendarEvent = {
  id: string;
  reference: string;
  title: string;
  /** Local wall-clock ISO without offset, in the organization timezone. */
  start: string;
  end: string;
  status: BookingStatus;
  cleaners: string[];
  services: string;
  city: string;
};

export async function calendarEvents(user: CurrentUser, q: z.infer<typeof calendarQuery>) {
  if (!user.permissions.has("calendar:read") && !user.permissions.has("bookings:read_assigned")) throw Errors.forbidden();
  await connectDb();
  const viewer = await viewerFor(user);
  const { timezone } = await orgSettings(user.organizationId);
  const { start, end } = localDaysRange(q.start, q.end, timezone);
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days <= 0 || days > MAX_CALENDAR_DAYS + 1) throw Errors.validation(`Choose a range of at most ${MAX_CALENDAR_DAYS} days.`);
  const filter: Record<string, unknown> = {
    organizationId: new Types.ObjectId(user.organizationId),
    // Bookings last at most 24 h, so a lower bound on the start keeps this an index range scan.
    scheduledStartAt: { $gte: new Date(start.getTime() - 24 * 60 * 60_000), $lt: end },
    scheduledEndAt: { $gt: start },
  };
  if (!viewer.office) {
    if (!viewer.cleanerId) return { timezone, events: [] as CalendarEvent[] };
    filter.assignedCleanerIds = viewer.cleanerId;
  } else {
    if (q.cleanerId) filter.assignedCleanerIds = new Types.ObjectId(q.cleanerId);
    if (q.city) filter["addressSnapshot.cityNormalized"] = normalizeCity(q.city);
  }
  if (q.status) filter.status = q.status;
  const rows = await Booking.find(filter)
    .select("reference customerId scheduledStartAt scheduledEndAt status assignedCleanerIds lineItems.name lineItems.quantity addressSnapshot.city timezone")
    .sort({ scheduledStartAt: 1, _id: 1 })
    .limit(1000)
    .lean();
  const [customers, cleaners] = await Promise.all([
    Customer.find({ _id: { $in: [...new Set(rows.map((r) => String(r.customerId)))] }, organizationId: user.organizationId }).select("name").lean(),
    Cleaner.find({ _id: { $in: [...new Set(rows.flatMap((r) => r.assignedCleanerIds.map(String)))] }, organizationId: user.organizationId }).select("name").lean(),
  ]);
  const cName = new Map(customers.map((c) => [String(c._id), c.name]));
  const clName = new Map(cleaners.map((c) => [String(c._id), c.name]));
  const wall = (d: Date) => `${localDateKey(d, timezone)}T${localTimeKey(d, timezone)}:00`;
  const events: CalendarEvent[] = rows.map((r) => ({
    id: String(r._id),
    reference: r.reference,
    title: cName.get(String(r.customerId)) ?? "Customer",
    start: wall(r.scheduledStartAt),
    end: wall(r.scheduledEndAt),
    status: r.status as BookingStatus,
    cleaners: r.assignedCleanerIds.map((id) => clName.get(String(id)) ?? "Former cleaner"),
    services: r.lineItems.map((l) => (l.quantity > 1 ? `${l.name} ×${l.quantity}` : l.name)).join(", "),
    city: r.addressSnapshot?.city ?? "",
  }));
  return { timezone, events };
}

// ---------------------------------------------------------------------------
// Operational summary
// ---------------------------------------------------------------------------

export type OperationsSummary = {
  timezone: string;
  today: string;
  tomorrow: string;
  todayCount: number;
  tomorrowCount: number;
  unassignedUpcoming: number;
  inProgress: number;
  completed: { from: string; to: string; bookings: number; serviceItems: number; uniqueCustomers: number };
  upcoming: BookingDTO[];
  todayJobs: BookingDTO[];
};

export async function operationsSummary(user: CurrentUser, range: { from?: string; to?: string }, now = new Date()): Promise<OperationsSummary> {
  if (!user.permissions.has("bookings:read")) throw Errors.forbidden();
  await connectDb();
  const viewer: Viewer = { user, office: true, cleanerId: null };
  const orgId = new Types.ObjectId(user.organizationId);
  const { timezone } = await orgSettings(orgId);
  const today = localDateKey(now, timezone);
  const tomorrow = addDaysToKey(today, 1);
  const todayR = localDaysRange(today, today, timezone);
  const tomorrowR = localDaysRange(tomorrow, tomorrow, timezone);
  const from = range.from ?? addDaysToKey(today, -6);
  const to = range.to ?? today;
  if (from > to) throw Errors.validation("The start date must be before the end date.");
  const completedR = localDaysRange(from, to, timezone);
  if ((completedR.end.getTime() - completedR.start.getTime()) / 86_400_000 > 367) throw Errors.validation("Choose a range of at most one year.");
  const notCancelled = { $ne: "CANCELLED" as const };

  const [todayCount, tomorrowCount, unassignedUpcoming, inProgress, completedAgg, upcomingRows, todayRows] = await Promise.all([
    Booking.countDocuments({ organizationId: orgId, status: notCancelled, scheduledStartAt: { $gte: todayR.start, $lt: todayR.end } }),
    Booking.countDocuments({ organizationId: orgId, status: notCancelled, scheduledStartAt: { $gte: tomorrowR.start, $lt: tomorrowR.end } }),
    Booking.countDocuments({ organizationId: orgId, status: "SCHEDULED", scheduledStartAt: { $gte: now }, assignedCleanerIds: { $size: 0 } }),
    Booking.countDocuments({ organizationId: orgId, status: "IN_PROGRESS" }),
    Booking.aggregate<{ bookings: number; items: number; customers: number }>([
      { $match: { organizationId: orgId, status: "COMPLETED", scheduledStartAt: { $gte: completedR.start, $lt: completedR.end } } },
      { $group: { _id: null, bookings: { $sum: 1 }, items: { $sum: { $sum: "$lineItems.quantity" } }, customers: { $addToSet: "$customerId" } } },
      { $project: { bookings: 1, items: 1, customers: { $size: "$customers" } } },
    ]),
    Booking.find({ organizationId: orgId, status: "SCHEDULED", scheduledStartAt: { $gte: now } }).sort({ scheduledStartAt: 1, _id: 1 }).limit(8).lean(),
    Booking.find({ organizationId: orgId, status: notCancelled, scheduledStartAt: { $gte: todayR.start, $lt: todayR.end } }).sort({ scheduledStartAt: 1, _id: 1 }).limit(20).lean(),
  ]);
  const c = completedAgg[0];
  return {
    timezone,
    today,
    tomorrow,
    todayCount,
    tomorrowCount,
    unassignedUpcoming,
    inProgress,
    completed: { from, to, bookings: c?.bookings ?? 0, serviceItems: c?.items ?? 0, uniqueCustomers: c?.customers ?? 0 },
    upcoming: await shapeBookings(viewer, upcomingRows as BookingDoc[]),
    todayJobs: await shapeBookings(viewer, todayRows as BookingDoc[]),
  };
}

/** A cleaner's own jobs: today onward (and anything still in progress). */
export async function myJobs(user: CurrentUser, now = new Date()) {
  if (!user.permissions.has("bookings:read_assigned")) throw Errors.forbidden();
  await connectDb();
  const viewer = await viewerFor(user);
  if (!viewer.cleanerId) return { linked: false as const, jobs: [] as BookingDTO[], recent: [] as BookingDTO[] };
  const { timezone } = await orgSettings(user.organizationId);
  const today = localDaysRange(localDateKey(now, timezone), localDateKey(now, timezone), timezone);
  const base = { organizationId: new Types.ObjectId(user.organizationId), assignedCleanerIds: viewer.cleanerId };
  const [jobs, recent] = await Promise.all([
    Booking.find({ ...base, $or: [{ status: "IN_PROGRESS" }, { status: "SCHEDULED", scheduledEndAt: { $gte: today.start } }] }).sort({ scheduledStartAt: 1, _id: 1 }).limit(50).lean(),
    Booking.find({ ...base, status: "COMPLETED" }).sort({ scheduledStartAt: -1, _id: -1 }).limit(10).lean(),
  ]);
  return { linked: true as const, jobs: await shapeBookings(viewer, jobs as BookingDoc[]), recent: await shapeBookings(viewer, recent as BookingDoc[]) };
}

/** Upcoming + completed jobs for a cleaner profile page (office view). */
export async function cleanerSchedule(user: CurrentUser, cleanerId: string, now = new Date()) {
  if (!user.permissions.has("cleaners:read") || !user.permissions.has("bookings:read")) throw Errors.forbidden();
  if (!OBJECT_ID_RE.test(cleanerId)) throw Errors.notFound("Cleaner");
  await connectDb();
  const viewer: Viewer = { user, office: true, cleanerId: null };
  const base = { organizationId: new Types.ObjectId(user.organizationId), assignedCleanerIds: new Types.ObjectId(cleanerId) };
  const [upcoming, completed] = await Promise.all([
    Booking.find({ ...base, status: { $in: BLOCKING_BOOKING_STATUSES }, scheduledEndAt: { $gte: now } }).sort({ scheduledStartAt: 1, _id: 1 }).limit(50).lean(),
    Booking.find({ ...base, status: "COMPLETED" }).sort({ scheduledStartAt: -1, _id: -1 }).limit(25).lean(),
  ]);
  return { upcoming: await shapeBookings(viewer, upcoming as BookingDoc[]), completed: await shapeBookings(viewer, completed as BookingDoc[]) };
}
