import "server-only";
import { Types, type ClientSession } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Activity } from "@/lib/db/models/activity";
import { Booking } from "@/lib/db/models/booking";
import { Customer } from "@/lib/db/models/customer";
import { User } from "@/lib/db/models/user";
import { CALL_OUTCOMES, type ActivityType, type CallOutcome } from "@/lib/domain/constants";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { Errors } from "@/lib/http/errors";
import { redact } from "@/lib/security/redact";

export type ActivityInput = {
  organizationId: Types.ObjectId | string;
  actorId?: Types.ObjectId | string | null;
  type: ActivityType;
  customerId?: Types.ObjectId | string | null;
  bookingId?: Types.ObjectId | string | null;
  content?: string;
  callOutcome?: CallOutcome | null;
  metadata?: Record<string, string | number | boolean | null | string[]>;
  /** Same key → recorded once (idempotent retries). */
  dedupeKey?: string | null;
};

/** Records a timeline event. Within a transaction, pass the session so it commits atomically. */
export async function recordActivity(input: ActivityInput, session?: ClientSession) {
  const doc = {
    organizationId: input.organizationId,
    actorId: input.actorId ?? null,
    type: input.type,
    customerId: input.customerId ?? null,
    bookingId: input.bookingId ?? null,
    content: input.content ?? "",
    callOutcome: input.callOutcome ?? null,
    metadata: redact(input.metadata ?? {}),
    dedupeKey: input.dedupeKey ?? null,
    occurredAt: new Date(),
  };
  try {
    await Activity.create([doc], { session });
  } catch (err) {
    if ((err as { code?: number }).code === 11000 && input.dedupeKey) return; // already recorded
    throw err;
  }
}

export const activityListQuery = z.object({
  customerId: z.string().regex(OBJECT_ID_RE).optional(),
  bookingId: z.string().regex(OBJECT_ID_RE).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const createNoteSchema = z
  .object({
    customerId: z.string().regex(OBJECT_ID_RE).optional(),
    bookingId: z.string().regex(OBJECT_ID_RE).optional(),
    kind: z.enum(["note", "call"]),
    content: z.string().trim().max(2000).default(""),
    callOutcome: z.enum(CALL_OUTCOMES).optional(),
  })
  .strict()
  .refine((v) => v.customerId || v.bookingId, "A customer or booking is required")
  .refine((v) => v.kind !== "call" || v.callOutcome, { message: "Choose a call outcome", path: ["callOutcome"] })
  .refine((v) => v.kind !== "note" || v.content.length > 0, { message: "Write a note", path: ["content"] });

export type ActivityItem = {
  id: string;
  type: ActivityType;
  content: string;
  callOutcome: CallOutcome | null;
  metadata: Record<string, unknown>;
  actorName: string | null;
  bookingId: string | null;
  customerId: string | null;
  occurredAt: string;
};

function assertOfficeViewer(user: CurrentUser) {
  // Activity history is office-only; cleaners never receive it.
  if (user.role === "CLEANER" || !(user.permissions.has("customers:read") || user.permissions.has("bookings:read"))) throw Errors.forbidden();
}

export async function listActivities(user: CurrentUser, q: z.infer<typeof activityListQuery>) {
  assertOfficeViewer(user);
  if (!q.customerId && !q.bookingId) throw Errors.validation("A customer or booking is required.");
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  const filter: Record<string, unknown> = { organizationId: orgId };
  if (q.bookingId) filter.bookingId = new Types.ObjectId(q.bookingId);
  if (q.customerId) filter.customerId = new Types.ObjectId(q.customerId);
  const [total, rows] = await Promise.all([
    Activity.countDocuments(filter),
    Activity.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
  ]);
  const actorIds = [...new Set(rows.map((r) => r.actorId && String(r.actorId)).filter(Boolean))] as string[];
  const actors = actorIds.length ? await User.find({ _id: { $in: actorIds }, organizationId: orgId }).select("name").lean() : [];
  const names = new Map(actors.map((a) => [String(a._id), a.name]));
  const items: ActivityItem[] = rows.map((r) => ({
    id: String(r._id),
    type: r.type as ActivityType,
    content: r.content ?? "",
    callOutcome: (r.callOutcome as CallOutcome | null) ?? null,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    actorName: r.actorId ? (names.get(String(r.actorId)) ?? "Former user") : null,
    bookingId: r.bookingId ? String(r.bookingId) : null,
    customerId: r.customerId ? String(r.customerId) : null,
    occurredAt: r.occurredAt.toISOString(),
  }));
  return { items, page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

/** Manual note or call outcome. A tel: link click never logs a call by itself. */
export async function addNote(user: CurrentUser, input: z.infer<typeof createNoteSchema>) {
  if (!user.permissions.has("activities:write") || user.role === "CLEANER") throw Errors.forbidden();
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  let customerId = input.customerId ? new Types.ObjectId(input.customerId) : null;
  const bookingId = input.bookingId ? new Types.ObjectId(input.bookingId) : null;
  if (bookingId) {
    const b = await Booking.findOne({ _id: bookingId, organizationId: orgId }).select("customerId").lean();
    if (!b) throw Errors.notFound("Booking");
    customerId = b.customerId;
  } else if (customerId && !(await Customer.exists({ _id: customerId, organizationId: orgId }))) {
    throw Errors.notFound("Customer");
  }
  await recordActivity({
    organizationId: orgId,
    actorId: user.id,
    type: input.kind,
    customerId,
    bookingId,
    content: input.content,
    callOutcome: input.kind === "call" ? (input.callOutcome ?? null) : null,
  });
  return { ok: true };
}
