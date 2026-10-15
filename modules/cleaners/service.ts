import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { withTransaction } from "@/lib/db/transaction";
import { Booking } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { User } from "@/lib/db/models/user";
import type { BookingStatus } from "@/lib/domain/constants";
import { escapeRegex, normalizeEmail, OBJECT_ID_RE } from "@/lib/domain/normalize";
import { parsePhone } from "@/lib/domain/phone";
import { AppError, Errors } from "@/lib/http/errors";
import { recordAudit } from "@/modules/audit/service";
import { validateCustomFieldValues } from "@/modules/custom-fields/service";
import { inviteUser } from "@/modules/users/service";

export const cleanerInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    /** Required so the office can always reach the cleaner. Creating a cleaner never creates a sign-in. */
    phone: z.string({ error: "Phone is required" }).trim().min(1, "Phone is required").max(40),
    phoneCountry: z.string().regex(/^[A-Z]{2}$/).default("CA"),
    email: z.union([z.literal(""), z.string().trim().email("Enter a valid email or leave it blank").max(254)]).default(""),
    serviceAreas: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    notes: z.string().trim().max(5000).default(""),
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const cleanerListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive", "archived", "all"]).default("active"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type CleanerDTO = {
  id: string;
  name: string;
  phone: string | null;
  phoneDisplay: string | null;
  email: string | null;
  active: boolean;
  archived: boolean;
  serviceAreas: string[];
  notes: string;
  linkedUser: { id: string; name: string; email: string; status: string } | null;
  customFields: Record<string, unknown>;
};

type CleanerLike = {
  _id: Types.ObjectId;
  name: string;
  phone?: string | null;
  phoneDisplay?: string | null;
  email?: string | null;
  active?: boolean | null;
  archivedAt?: Date | null;
  serviceAreas?: string[] | null;
  notes?: string | null;
  linkedUserId?: Types.ObjectId | null;
  customFields?: unknown;
};

function toCleanerDTO(c: CleanerLike, linked?: { _id: Types.ObjectId; name: string; email: string; status: string } | null): CleanerDTO {
  return {
    id: String(c._id),
    name: c.name,
    phone: c.phone ?? null,
    phoneDisplay: c.phoneDisplay ?? c.phone ?? null,
    email: c.email ?? null,
    active: Boolean(c.active) && !c.archivedAt,
    archived: Boolean(c.archivedAt),
    serviceAreas: c.serviceAreas ?? [],
    notes: c.notes ?? "",
    linkedUser: linked ? { id: String(linked._id), name: linked.name, email: linked.email, status: linked.status } : null,
    customFields: (c.customFields && typeof c.customFields === "object" ? c.customFields : {}) as Record<string, unknown>,
  };
}

function storedFields(input: z.infer<typeof cleanerInputSchema>) {
  let phone: ReturnType<typeof parsePhone> = null;
  if (input.phone) {
    phone = parsePhone(input.phone, input.phoneCountry);
    if (!phone) throw Errors.validation("Enter a valid phone number.", { phone: ["Enter a valid phone number, including the area code."] });
  }
  return {
    name: input.name,
    searchName: input.name.toLowerCase(),
    phone: phone?.e164 ?? null,
    phoneDisplay: phone?.display ?? null,
    email: input.email ? normalizeEmail(input.email) : null,
    serviceAreas: input.serviceAreas,
    notes: input.notes,
  };
}

function assertRead(user: CurrentUser) {
  if (!user.permissions.has("cleaners:read")) throw Errors.forbidden();
}
function assertWrite(user: CurrentUser) {
  if (!user.permissions.has("cleaners:write")) throw Errors.forbidden();
}

async function loadCleaner(user: CurrentUser, id: string) {
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Cleaner");
  const c = await Cleaner.findOne({ _id: id, organizationId: user.organizationId }).lean();
  if (!c) throw Errors.notFound("Cleaner");
  return c;
}

export async function listCleaners(user: CurrentUser, q: z.infer<typeof cleanerListQuery>) {
  assertRead(user);
  await connectDb();
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(user.organizationId) };
  if (q.status === "active") Object.assign(filter, { archivedAt: null, active: true });
  if (q.status === "inactive") Object.assign(filter, { archivedAt: null, active: false });
  if (q.status === "archived") filter.archivedAt = { $ne: null };
  if (q.q) filter.searchName = { $regex: escapeRegex(q.q.toLowerCase()) };
  const [total, rows] = await Promise.all([
    Cleaner.countDocuments(filter),
    Cleaner.find(filter).sort({ searchName: 1, _id: 1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
  ]);
  const userIds = rows.map((r) => r.linkedUserId).filter(Boolean);
  const users = userIds.length ? await User.find({ _id: { $in: userIds }, organizationId: user.organizationId }).select("name email status").lean() : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return {
    items: rows.map((r) => toCleanerDTO(r, r.linkedUserId ? byId.get(String(r.linkedUserId)) : null)),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

/** Active, assignable cleaners for booking forms (bounded). */
export async function assignableCleaners(user: CurrentUser) {
  if (!user.permissions.has("bookings:write")) throw Errors.forbidden();
  await connectDb();
  const rows = await Cleaner.find({ organizationId: user.organizationId, active: true, archivedAt: null }).select("name phoneDisplay phone").sort({ searchName: 1, _id: 1 }).limit(500).lean();
  return rows.map((r) => ({ id: String(r._id), name: r.name, phoneDisplay: r.phoneDisplay ?? r.phone ?? null }));
}

export async function getCleaner(user: CurrentUser, id: string) {
  assertRead(user);
  await connectDb();
  const c = await loadCleaner(user, id);
  const linked = c.linkedUserId ? await User.findOne({ _id: c.linkedUserId, organizationId: user.organizationId }).select("name email status").lean() : null;
  return toCleanerDTO(c, linked);
}

export async function createCleaner(user: CurrentUser, raw: unknown) {
  assertWrite(user);
  const input = cleanerInputSchema.parse(raw);
  await connectDb();
  // A cleaner profile never grants login access by itself.
  const customFields = await validateCustomFieldValues(user.organizationId, "cleaner", input.customFields, {}, "create");
  const doc = await Cleaner.create({ organizationId: user.organizationId, ...storedFields(input), customFields });
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "cleaner.created", entityType: "cleaner", entityId: doc._id });
  return toCleanerDTO(doc.toObject());
}

export async function updateCleaner(user: CurrentUser, id: string, raw: unknown) {
  assertWrite(user);
  const input = cleanerInputSchema.parse(raw);
  await connectDb();
  const c = await loadCleaner(user, id);
  const customFields = input.customFields !== undefined ? await validateCustomFieldValues(user.organizationId, "cleaner", input.customFields, (c.customFields ?? {}) as Record<string, unknown>, "update") : undefined;
  await Cleaner.updateOne({ _id: c._id }, { $set: { ...storedFields(input), ...(customFields ? { customFields } : {}) } });
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "cleaner.updated", entityType: "cleaner", entityId: c._id });
  return getCleaner(user, id);
}

export type AffectedBooking = { id: string; reference: string; scheduledStartAt: string; customerName: string; status: BookingStatus };

/** Future scheduled/in-progress bookings still assigned to a cleaner. */
export async function futureAssignments(organizationId: Types.ObjectId | string, cleanerId: Types.ObjectId, now = new Date()): Promise<AffectedBooking[]> {
  const rows = await Booking.find({
    organizationId,
    assignedCleanerIds: cleanerId,
    status: { $in: ["SCHEDULED", "IN_PROGRESS"] },
    scheduledEndAt: { $gt: now },
  })
    .select("reference scheduledStartAt customerId status")
    .sort({ scheduledStartAt: 1, _id: 1 })
    .limit(200)
    .lean();
  const customers = await Customer.find({ _id: { $in: rows.map((r) => r.customerId) } }).select("name").lean();
  const names = new Map(customers.map((c) => [String(c._id), c.name]));
  return rows.map((r) => ({ id: String(r._id), reference: r.reference, scheduledStartAt: r.scheduledStartAt.toISOString(), customerName: names.get(String(r.customerId)) ?? "—", status: r.status as BookingStatus }));
}

/**
 * Activate/deactivate/archive. Bumps scheduleRevision so an assignment racing
 * with deactivation write-conflicts instead of slipping through. Existing
 * assignments are kept and returned so staff can reassign them explicitly.
 */
export async function setCleanerState(user: CurrentUser, id: string, state: "active" | "inactive" | "archived") {
  assertWrite(user);
  await connectDb();
  const c = await loadCleaner(user, id);
  await withTransaction(async (session) => {
    await Cleaner.updateOne(
      { _id: c._id, organizationId: user.organizationId },
      {
        $set: { active: state === "active", archivedAt: state === "archived" ? (c.archivedAt ?? new Date()) : null, archivedBy: state === "archived" ? user.id : null },
        $inc: { scheduleRevision: 1 },
      },
      { session },
    );
  });
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: `cleaner.${state === "active" ? "activated" : state === "inactive" ? "deactivated" : "archived"}`, entityType: "cleaner", entityId: c._id });
  return { cleaner: await getCleaner(user, id), affectedBookings: state === "active" ? [] : await futureAssignments(user.organizationId, c._id) };
}

/** CLEANER-role users in the org not yet linked to any cleaner record. */
export async function linkableUsers(user: CurrentUser) {
  assertWrite(user);
  await connectDb();
  const linked = await Cleaner.find({ organizationId: user.organizationId, linkedUserId: { $ne: null } }).select("linkedUserId").lean();
  const rows = await User.find({ organizationId: user.organizationId, role: "CLEANER", _id: { $nin: linked.map((l) => l.linkedUserId) } })
    .select("name email status")
    .sort({ name: 1 })
    .limit(200)
    .lean();
  return rows.map((u) => ({ id: String(u._id), name: u.name, email: u.email, status: u.status }));
}

export const linkUserSchema = z.object({ userId: z.union([z.string().regex(OBJECT_ID_RE), z.null()]) }).strict();

/** Links (or unlinks with null) a CLEANER user. A user can be linked to only one cleaner. */
export async function linkCleanerUser(user: CurrentUser, id: string, userId: string | null) {
  assertWrite(user);
  if (!user.permissions.has("users:manage")) throw Errors.forbidden("Linking sign-in accounts requires user-management permission.");
  await connectDb();
  const c = await loadCleaner(user, id);
  if (userId) {
    const target = await User.findOne({ _id: userId, organizationId: user.organizationId }).select("role").lean();
    if (!target) throw Errors.notFound("User");
    if (target.role !== "CLEANER") throw Errors.validation("Only users with the Cleaner role can be linked to a cleaner profile.");
  }
  try {
    await Cleaner.updateOne({ _id: c._id }, { $set: { linkedUserId: userId ? new Types.ObjectId(userId) : null } });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw new AppError(409, "USER_ALREADY_LINKED", "That account is already linked to another cleaner profile.");
    throw err;
  }
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: userId ? "cleaner.user_linked" : "cleaner.user_unlinked", entityType: "cleaner", entityId: c._id });
  return getCleaner(user, id);
}

/**
 * Explicit invitation of a cleaner to sign in, via the existing invitation
 * flow (role CLEANER), then linking the new account to this profile.
 */
export async function inviteCleaner(user: CurrentUser, id: string) {
  assertWrite(user);
  await connectDb();
  const c = await loadCleaner(user, id);
  if (c.linkedUserId) throw new AppError(409, "ALREADY_LINKED", "This cleaner already has a linked sign-in account.");
  if (!c.email) throw Errors.validation("Add an email address to this cleaner before inviting them.");
  let invitedId: string | null = null;
  try {
    const res = await inviteUser(user, { email: c.email, name: c.name, role: "CLEANER" });
    invitedId = res.id;
  } catch (err) {
    // Email failure: the invited user exists; still link so a resend works from Users.
    if (err instanceof AppError && err.code === "EMAIL_DELIVERY_FAILED" && typeof err.details?.userId === "string") invitedId = err.details.userId;
    if (invitedId) await Cleaner.updateOne({ _id: c._id, linkedUserId: null }, { $set: { linkedUserId: new Types.ObjectId(invitedId) } });
    throw err;
  }
  await Cleaner.updateOne({ _id: c._id, linkedUserId: null }, { $set: { linkedUserId: new Types.ObjectId(invitedId) } });
  return getCleaner(user, id);
}

/** The cleaner record linked to a CLEANER user, if any. */
export async function cleanerForUser(user: CurrentUser) {
  await connectDb();
  return Cleaner.findOne({ organizationId: user.organizationId, linkedUserId: user.id }).select("_id name active archivedAt").lean();
}
