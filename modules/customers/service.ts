import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { withTransaction } from "@/lib/db/transaction";
import { Booking } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { ServiceAddress } from "@/lib/db/models/service-address";
import type { BookingStatus, ContactSource, CustomerType } from "@/lib/domain/constants";
import { escapeRegex, normalizeCity, normalizeEmail, OBJECT_ID_RE } from "@/lib/domain/normalize";
import { parsePhone, phoneSearchDigits } from "@/lib/domain/phone";
import { AppError, Errors } from "@/lib/http/errors";
import { recordActivity } from "@/modules/activities/service";
import { customFieldDefsFor, validateCustomFieldValues, visibleCustomFieldValues } from "@/modules/custom-fields/service";
import { addressFieldsFromInput, refreshCustomerCities } from "./addresses";
import { createCustomerSchema, customerListQuery, displayNameOf, updateCustomerSchema, type CustomerFields } from "./schemas";

export type CustomerDTO = {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  companyName: string;
  customerType: CustomerType;
  email: string | null;
  phone: string | null;
  phoneDisplay: string | null;
  relationshipStartedAt: string | null; // YYYY-MM-DD (date only)
  contactSource: ContactSource | null;
  tags: string[];
  notes: string;
  primaryCity: string | null;
  archived: boolean;
  createdAt: string;
  customFields: Record<string, unknown>;
};

type CustomerLike = {
  _id: Types.ObjectId;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  customerType?: string | null;
  email?: string | null;
  phone?: string | null;
  phoneDisplay?: string | null;
  relationshipStartedAt?: Date | null;
  contactSource?: string | null;
  tags?: string[] | null;
  notes?: string | null;
  primaryCity?: string | null;
  archivedAt?: Date | null;
  createdAt?: Date;
  customFields?: unknown;
};

/** Date-only values are stored at 00:00 UTC of that calendar date. */
export function dateKeyToStoredDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}
export function storedDateToKey(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function toCustomerDTO(c: CustomerLike): CustomerDTO {
  return {
    id: String(c._id),
    name: c.name,
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    companyName: c.companyName ?? "",
    customerType: (c.customerType ?? "individual") as CustomerType,
    email: c.email ?? null,
    phone: c.phone ?? null,
    phoneDisplay: c.phoneDisplay ?? c.phone ?? null,
    relationshipStartedAt: storedDateToKey(c.relationshipStartedAt),
    contactSource: (c.contactSource ?? null) as ContactSource | null,
    tags: c.tags ?? [],
    notes: c.notes ?? "",
    primaryCity: c.primaryCity ?? null,
    archived: Boolean(c.archivedAt),
    createdAt: (c.createdAt ?? new Date(0)).toISOString(),
    // Shaped again per viewer/definitions by callers that expose custom fields.
    customFields: (c.customFields && typeof c.customFields === "object" ? c.customFields : {}) as Record<string, unknown>,
  };
}

/** Converts validated input into stored fields (normalised phone/email/name). */
function storedFields(input: CustomerFields) {
  let phone: ReturnType<typeof parsePhone> = null;
  if (input.phone.trim()) {
    phone = parsePhone(input.phone, input.phoneCountry);
    if (!phone) throw Errors.validation("Enter a valid phone number.", { phone: ["Enter a valid phone number, including the area code."] });
  }
  const name = displayNameOf(input);
  return {
    name,
    searchName: name.toLowerCase(),
    firstName: input.customerType === "individual" ? input.firstName : "",
    lastName: input.customerType === "individual" ? input.lastName : "",
    companyName: input.companyName || (input.customerType !== "individual" ? input.displayName : ""),
    customerType: input.customerType,
    email: input.email ? normalizeEmail(input.email) : null,
    phone: phone?.e164 ?? null,
    phoneDigits: phone?.digits ?? null,
    phoneDisplay: phone?.display ?? null,
    phoneCountry: phone?.country ?? null,
    relationshipStartedAt: input.relationshipStartedAt ? dateKeyToStoredDate(input.relationshipStartedAt) : null,
    contactSource: input.contactSource || null,
    tags: input.tags,
    notes: input.notes,
  };
}

export type DuplicateMatch = { id: string; name: string; phoneDisplay: string | null; email: string | null; primaryCity: string | null; archived: boolean; matchedOn: string[] };

/**
 * Possible duplicates by exact phone, email or name. Shared contact details are
 * legitimate (households, businesses), so this warns rather than blocks.
 */
export async function findPossibleDuplicates(
  organizationId: Types.ObjectId,
  probe: { phone: string | null; email: string | null; searchName: string },
  excludeId?: Types.ObjectId,
): Promise<DuplicateMatch[]> {
  const or: Record<string, unknown>[] = [{ searchName: probe.searchName }];
  if (probe.phone) or.push({ phone: probe.phone });
  if (probe.email) or.push({ email: probe.email });
  const rows = await Customer.find({ organizationId, $or: or, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })
    .select("name searchName phone phoneDisplay email primaryCity archivedAt")
    .limit(5)
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    name: r.name,
    phoneDisplay: r.phoneDisplay ?? r.phone ?? null,
    email: r.email ?? null,
    primaryCity: r.primaryCity ?? null,
    archived: Boolean(r.archivedAt),
    matchedOn: [
      ...(probe.phone && r.phone === probe.phone ? ["phone"] : []),
      ...(probe.email && r.email === probe.email ? ["email"] : []),
      ...(r.searchName === probe.searchName ? ["name"] : []),
    ],
  }));
}

export async function checkDuplicates(user: CurrentUser, raw: unknown) {
  if (!user.permissions.has("customers:read")) throw Errors.forbidden();
  const input = updateCustomerSchema.parse(raw);
  await connectDb();
  const f = storedFields(input);
  return { matches: await findPossibleDuplicates(new Types.ObjectId(user.organizationId), f) };
}

/** `opts.importRef` makes creation idempotent for CSV imports (same ref → same customer). */
export async function createCustomer(user: CurrentUser, raw: unknown, opts: { importRef?: string } = {}) {
  if (!user.permissions.has("customers:write")) throw Errors.forbidden();
  const input = createCustomerSchema.parse(raw);
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  const fields = storedFields(input);
  const customFields = await validateCustomFieldValues(orgId, "customer", input.customFields, {}, "create");
  if (!input.confirmDuplicate) {
    const matches = await findPossibleDuplicates(orgId, fields);
    if (matches.length > 0) {
      throw new AppError(409, "POSSIBLE_DUPLICATES", "Similar customers already exist. Review them, then continue if this is a different customer.", { matches });
    }
  }
  // Customers are not users: no account or invitation is ever created here.
  if (opts.importRef) {
    const prior = await Customer.findOne({ organizationId: orgId, importRef: opts.importRef }).lean();
    if (prior) return toCustomerDTO(prior);
  }
  const id = await withTransaction(async (session) => {
    const [customer] = await Customer.create([{ organizationId: orgId, ...fields, customFields, createdBy: user.id, importRef: opts.importRef ?? null }], { session });
    if (input.primaryAddress) {
      await ServiceAddress.create(
        [{ organizationId: orgId, customerId: customer!._id, ...addressFieldsFromInput(input.primaryAddress), isPrimary: true }],
        { session },
      );
      await refreshCustomerCities(orgId, customer!._id, session);
    }
    await recordActivity({ organizationId: orgId, actorId: user.id, type: "customer.created", customerId: customer!._id, metadata: { duplicateConfirmed: input.confirmDuplicate } }, session);
    return customer!._id;
  });
  return toCustomerDTO((await Customer.findById(id).lean())!);
}

async function loadOrgCustomer(user: CurrentUser, id: string) {
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Customer");
  const c = await Customer.findOne({ _id: id, organizationId: user.organizationId }).lean();
  if (!c) throw Errors.notFound("Customer");
  return c;
}

export async function updateCustomer(user: CurrentUser, id: string, raw: unknown) {
  if (!user.permissions.has("customers:write")) throw Errors.forbidden();
  const input = updateCustomerSchema.parse(raw);
  await connectDb();
  const existing = await loadOrgCustomer(user, id);
  const fields = storedFields(input);
  const customFields = input.customFields !== undefined ? await validateCustomFieldValues(user.organizationId, "customer", input.customFields, (existing.customFields ?? {}) as Record<string, unknown>, "update") : undefined;
  await Customer.updateOne({ _id: existing._id, organizationId: user.organizationId }, { $set: { ...fields, ...(customFields ? { customFields } : {}) } });
  const changed = (Object.keys(fields) as (keyof typeof fields)[]).filter((k) => JSON.stringify(fields[k]) !== JSON.stringify((existing as Record<string, unknown>)[k] ?? null));
  if (changed.length) {
    await recordActivity({ organizationId: user.organizationId, actorId: user.id, type: "customer.updated", customerId: existing._id, metadata: { fields: changed.filter((k) => k !== "searchName" && k !== "phoneDigits") } });
  }
  return toCustomerDTO((await Customer.findById(existing._id).lean())!);
}

/** Soft archive: history (bookings, payments, activities) is always preserved. */
export async function setCustomerArchived(user: CurrentUser, id: string, archived: boolean) {
  if (!user.permissions.has("customers:write")) throw Errors.forbidden();
  await connectDb();
  const existing = await loadOrgCustomer(user, id);
  if (Boolean(existing.archivedAt) === archived) return toCustomerDTO(existing);
  await Customer.updateOne({ _id: existing._id }, { $set: { archivedAt: archived ? new Date() : null, archivedBy: archived ? user.id : null } });
  await recordActivity({ organizationId: user.organizationId, actorId: user.id, type: archived ? "customer.archived" : "customer.unarchived", customerId: existing._id });
  return toCustomerDTO((await Customer.findById(existing._id).lean())!);
}

export async function getCustomer(user: CurrentUser, id: string): Promise<CustomerDTO> {
  if (!user.permissions.has("customers:read")) throw Errors.forbidden();
  await connectDb();
  const dto = toCustomerDTO(await loadOrgCustomer(user, id));
  dto.customFields = visibleCustomFieldValues(await customFieldDefsFor(user.organizationId, "customer"), dto.customFields, "office");
  return dto;
}

/** Builds an allowlisted filter for search text: phone digits, email, or name. */
function searchFilter(q: string): Record<string, unknown> | null {
  const trimmed = q.trim().slice(0, 100);
  if (!trimmed) return null;
  const or: Record<string, unknown>[] = [{ searchName: { $regex: escapeRegex(trimmed.toLowerCase()) } }];
  const digits = phoneSearchDigits(trimmed);
  if (digits.length >= 3 && /^[\d\s()+.-]+$/.test(trimmed)) or.push({ phoneDigits: { $regex: escapeRegex(digits) } });
  if (trimmed.includes("@") || /^[\w.+-]+$/.test(trimmed)) or.push({ email: { $regex: `^${escapeRegex(trimmed.toLowerCase())}` } });
  return { $or: or };
}

export async function listCustomers(user: CurrentUser, query: z.infer<typeof customerListQuery>) {
  if (!user.permissions.has("customers:read")) throw Errors.forbidden();
  await connectDb();
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(user.organizationId) };
  if (query.status === "active") filter.archivedAt = null;
  if (query.status === "archived") filter.archivedAt = { $ne: null };
  if (query.city) filter.addressCities = normalizeCity(query.city);
  if (query.tag) filter.tags = { $regex: `^${escapeRegex(query.tag)}$`, $options: "i" };
  const search = query.q ? searchFilter(query.q) : null;
  if (search) Object.assign(filter, search);
  let warnings: string[] = [];
  if (query.f) {
    // Same allowlisted engine as reports; compiled server-side, never raw client operators.
    const { conditionSchema, decodeDefinition, MAX_CONDITIONS } = await import("@/modules/reports/definition");
    const { compileFilters, fieldRegistry } = await import("@/modules/reports/filters");
    let conds;
    try {
      conds = z.array(conditionSchema).max(MAX_CONDITIONS).parse(decodeDefinition(query.f));
    } catch {
      throw Errors.validation("The advanced filters couldn't be read. Clear them and try again.");
    }
    const compiled = compileFilters(await fieldRegistry(user, "customer_list"), conds, true);
    warnings = compiled.warnings;
    if (compiled.customer.length) filter.$and = compiled.customer;
  }
  const sortField = query.sort === "name" ? "searchName" : query.sort;
  const dir = query.dir === "asc" ? 1 : -1;
  const [total, rows] = await Promise.all([
    Customer.countDocuments(filter),
    Customer.find(filter)
      .select("name firstName lastName companyName customerType email phone phoneDisplay relationshipStartedAt contactSource tags primaryCity archivedAt createdAt customFields")
      .sort({ [sortField]: dir, _id: dir })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean(),
  ]);
  const defs = await customFieldDefsFor(user.organizationId, "customer");
  const items = rows.map((r) => {
    const dto = toCustomerDTO(r);
    dto.customFields = visibleCustomFieldValues(defs, dto.customFields, "office");
    return dto;
  });
  return { items, warnings, page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) };
}

/** Autocomplete for booking creation: active customers only, enough detail to tell namesakes apart. */
export async function lookupCustomers(user: CurrentUser, q: string) {
  if (!user.permissions.has("customers:read")) throw Errors.forbidden();
  await connectDb();
  const search = searchFilter(q);
  if (!search) return { items: [] };
  const rows = await Customer.find({ organizationId: new Types.ObjectId(user.organizationId), archivedAt: null, ...search })
    .select("name phone phoneDisplay email primaryCity customerType companyName")
    .sort({ searchName: 1, _id: 1 })
    .limit(10)
    .lean();
  return { items: rows.map((r) => ({ id: String(r._id), name: r.name, phoneDisplay: r.phoneDisplay ?? r.phone ?? null, email: r.email ?? null, primaryCity: r.primaryCity ?? null, companyName: r.companyName ?? "" })) };
}

export type CustomerMetrics = {
  completedBookings: number;
  /** Service lines in completed bookings (a booking with sofa + carpet = 2 services). */
  completedServices: number;
  completedServiceItems: number;
  distinctServiceDays: number;
  upcomingBookings: number;
  firstCompletedAt: string | null;
  lastCompletedAt: string | null;
};

/**
 * Service metrics (definitions in PROJECT_STATE.md):
 *  - completed bookings: bookings with status COMPLETED;
 *  - completed service items: sum of line-item quantities in those bookings;
 *  - distinct service days: distinct local calendar dates (organization
 *    timezone) of the scheduled start of completed bookings;
 *  - upcoming: SCHEDULED bookings starting now or later.
 */
export async function customerMetrics(organizationId: Types.ObjectId, customerId: Types.ObjectId, timezone: string, now = new Date()): Promise<CustomerMetrics> {
  const [res] = await Booking.aggregate<{
    completed: { bookings: number; services: number; items: number; first: Date; last: Date; days: string[] }[];
    upcoming: { n: number }[];
  }>([
    { $match: { organizationId, customerId } },
    {
      $facet: {
        completed: [
          { $match: { status: "COMPLETED" } },
          {
            $group: {
              _id: null,
              bookings: { $sum: 1 },
              services: { $sum: { $size: "$lineItems" } },
              items: { $sum: { $sum: "$lineItems.quantity" } },
              first: { $min: "$scheduledStartAt" },
              last: { $max: "$scheduledStartAt" },
              days: { $addToSet: { $dateToString: { format: "%Y-%m-%d", date: "$scheduledStartAt", timezone } } },
            },
          },
        ],
        upcoming: [{ $match: { status: "SCHEDULED", scheduledStartAt: { $gte: now } } }, { $count: "n" }],
      },
    },
  ]);
  const c = res?.completed[0];
  return {
    completedBookings: c?.bookings ?? 0,
    completedServices: c?.services ?? 0,
    completedServiceItems: c?.items ?? 0,
    distinctServiceDays: c?.days.length ?? 0,
    upcomingBookings: res?.upcoming[0]?.n ?? 0,
    firstCompletedAt: c?.first ? c.first.toISOString() : null,
    lastCompletedAt: c?.last ? c.last.toISOString() : null,
  };
}

export type HistoryRow = {
  id: string;
  reference: string;
  scheduledStartAt: string;
  status: BookingStatus;
  address: string;
  services: string;
  cleaners: string[];
  subtotalCents: number | null;
  currency: string;
};

/** Service history with cleaner names resolved in one query (no N+1). */
export async function customerHistory(user: CurrentUser, customerId: string, page = 1, pageSize = 20) {
  if (!user.permissions.has("customers:read") || !user.permissions.has("bookings:read")) throw Errors.forbidden();
  await connectDb();
  const c = await loadOrgCustomer(user, customerId);
  const filter = { organizationId: new Types.ObjectId(user.organizationId), customerId: c._id };
  const [total, rows] = await Promise.all([
    Booking.countDocuments(filter),
    Booking.find(filter)
      .select("reference scheduledStartAt status addressSnapshot lineItems.name lineItems.quantity assignedCleanerIds subtotalCents currency")
      .sort({ scheduledStartAt: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
  ]);
  const cleanerIds = [...new Set(rows.flatMap((r) => r.assignedCleanerIds.map(String)))];
  const cleaners = cleanerIds.length ? await Cleaner.find({ _id: { $in: cleanerIds }, organizationId: user.organizationId }).select("name").lean() : [];
  const names = new Map(cleaners.map((x) => [String(x._id), x.name]));
  const canPrice = user.permissions.has("pricing:read");
  const items: HistoryRow[] = rows.map((r) => ({
    id: String(r._id),
    reference: r.reference,
    scheduledStartAt: r.scheduledStartAt.toISOString(),
    status: r.status as BookingStatus,
    address: [r.addressSnapshot?.line1, r.addressSnapshot?.city].filter(Boolean).join(", "),
    services: r.lineItems.map((l) => (l.quantity > 1 ? `${l.name} ×${l.quantity}` : l.name)).join(", "),
    cleaners: r.assignedCleanerIds.map((id) => names.get(String(id)) ?? "Former cleaner"),
    subtotalCents: canPrice ? r.subtotalCents : null,
    currency: r.currency,
  }));
  return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export type ServiceLineRow = {
  bookingId: string;
  lineItemId: string;
  reference: string;
  date: string;
  service: string;
  quantity: number;
  address: string;
  city: string;
  /** Payments applied to this service line (net of refunds). Null without financial access. Never the booking price. */
  paidCents: number | null;
  cleaners: { id: string; name: string }[];
  status: BookingStatus;
  currency: string;
  /** Upcoming only: the booking still uses an older version of an address the customer has since edited. */
  outdatedAddress: { addressId: string; version: number; current: string } | null;
};

/**
 * Service history, one row per service line (date, service, the address the
 * job was actually done at, amount paid toward that service, cleaners,
 * status). `scope: "upcoming"` = scheduled from now on; otherwise past and
 * in-progress/completed/cancelled jobs.
 */
export async function customerServiceLines(user: CurrentUser, customerId: string, opts: { scope: "history" | "upcoming"; page?: number; pageSize?: number }, now = new Date()) {
  if (!user.permissions.has("customers:read") || !user.permissions.has("bookings:read")) throw Errors.forbidden();
  await connectDb();
  const c = await loadOrgCustomer(user, customerId);
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 25;
  const base = { organizationId: new Types.ObjectId(user.organizationId), customerId: c._id };
  const filter =
    opts.scope === "upcoming"
      ? { ...base, status: "SCHEDULED", scheduledStartAt: { $gte: now } }
      : { ...base, $or: [{ status: { $in: ["COMPLETED", "CANCELLED", "IN_PROGRESS"] } }, { scheduledStartAt: { $lt: now } }] };
  const sort: Record<string, 1 | -1> = opts.scope === "upcoming" ? { scheduledStartAt: 1, _id: 1 } : { scheduledStartAt: -1, _id: -1 };
  const [agg] = await Booking.aggregate<{ rows: Record<string, unknown>[]; count: { n: number }[] }>([
    { $match: filter },
    { $sort: sort },
    { $unwind: "$lineItems" },
    {
      $facet: {
        rows: [
          { $skip: (page - 1) * pageSize },
          { $limit: pageSize },
          { $project: { reference: 1, scheduledStartAt: 1, status: 1, currency: 1, version: 1, serviceAddressId: 1, assignedCleanerIds: 1, snap: "$addressSnapshot", line1: "$addressSnapshot.line1", city: "$addressSnapshot.city", line: "$lineItems" } },
        ],
        count: [{ $count: "n" }],
      },
    },
  ]);
  const rows = agg?.rows ?? [];
  const cleanerIds = [...new Set(rows.flatMap((r) => (r.assignedCleanerIds as Types.ObjectId[]).map(String)))];
  const cleaners = cleanerIds.length ? await Cleaner.find({ _id: { $in: cleanerIds }, organizationId: user.organizationId }).select("name").lean() : [];
  const names = new Map(cleaners.map((x) => [String(x._id), x.name]));
  const canMoney = user.permissions.has("financials:read");
  const total = agg?.count[0]?.n ?? 0;
  // Upcoming jobs keep the address snapshot taken when booked; flag those whose address has been edited since.
  const addrKey = (a: { line1?: string | null; line2?: string | null; city?: string | null; region?: string | null; postalCode?: string | null }) => [a.line1, a.line2, a.city, a.region, a.postalCode].map((x) => String(x ?? "").trim().toLowerCase()).join("|");
  const currentAddresses =
    opts.scope === "upcoming" && rows.length
      ? new Map((await ServiceAddress.find({ _id: { $in: rows.map((r) => r.serviceAddressId).filter(Boolean) }, organizationId: user.organizationId, archivedAt: null }).lean()).map((a) => [String(a._id), a]))
      : new Map();
  const items: ServiceLineRow[] = rows.map((r) => {
    const line = r.line as { _id: Types.ObjectId; name: string; quantity: number; allocatedCents?: number };
    return {
      bookingId: String(r._id),
      lineItemId: String(line._id),
      reference: String(r.reference),
      date: (r.scheduledStartAt as Date).toISOString(),
      service: line.name,
      quantity: line.quantity,
      address: String(r.line1 ?? ""),
      city: String(r.city ?? ""),
      paidCents: canMoney ? (line.allocatedCents ?? 0) : null,
      cleaners: (r.assignedCleanerIds as Types.ObjectId[]).map((id) => ({ id: String(id), name: names.get(String(id)) ?? "Former cleaner" })),
      status: r.status as BookingStatus,
      currency: String(r.currency),
      outdatedAddress: (() => {
        const cur = currentAddresses.get(String(r.serviceAddressId));
        if (!cur || addrKey(cur) === addrKey((r.snap ?? {}) as Record<string, string>)) return null;
        return { addressId: String(cur._id), version: Number(r.version), current: [cur.line1, cur.city].filter(Boolean).join(", ") };
      })(),
    };
  });
  return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Sets custom-field values from the profile (validated against the definitions; other fields untouched). */
export async function updateCustomerCustomFields(user: CurrentUser, id: string, raw: unknown) {
  if (!user.permissions.has("customers:write")) throw Errors.forbidden();
  const input = z.object({ customFields: z.record(z.string(), z.unknown()) }).strict().parse(raw);
  await connectDb();
  const existing = await loadOrgCustomer(user, id);
  const customFields = await validateCustomFieldValues(user.organizationId, "customer", input.customFields, (existing.customFields ?? {}) as Record<string, unknown>, "update");
  await Customer.updateOne({ _id: existing._id, organizationId: user.organizationId }, { $set: { customFields } });
  await recordActivity({ organizationId: user.organizationId, actorId: user.id, type: "customer.updated", customerId: existing._id, metadata: { fields: ["custom fields"] } });
  return toCustomerDTO((await Customer.findById(existing._id).lean())!);
}
