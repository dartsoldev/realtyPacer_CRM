import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Service } from "@/lib/db/models/service";
import { MAX_BOOKING_MINUTES, MAX_UNIT_PRICE_CENTS } from "@/lib/domain/constants";
import { escapeRegex, OBJECT_ID_RE } from "@/lib/domain/normalize";
import { Errors } from "@/lib/http/errors";
import { recordAudit } from "@/modules/audit/service";

const cents = z.number().int("Use whole cents").min(0).max(MAX_UNIT_PRICE_CENTS);

export const serviceInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    description: z.string().trim().max(2000).default(""),
    category: z.string().trim().max(60).default(""),
    defaultPriceCents: cents,
    durationMinutes: z.number().int("Use whole minutes").min(0).max(MAX_BOOKING_MINUTES),
    unitLabel: z.string().trim().min(1).max(30).default("item"),
    active: z.boolean().default(true),
  })
  .strict();

export const serviceListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type ServiceDTO = {
  id: string;
  name: string;
  description: string;
  category: string;
  defaultPriceCents: number | null;
  currency: string;
  durationMinutes: number;
  unitLabel: string;
  active: boolean;
};

type ServiceLike = {
  _id: Types.ObjectId;
  name: string;
  description?: string | null;
  category?: string | null;
  defaultPriceCents: number;
  currency: string;
  durationMinutes: number;
  unitLabel?: string | null;
  active?: boolean | null;
};

export function toServiceDTO(s: ServiceLike, canPrice: boolean): ServiceDTO {
  return {
    id: String(s._id),
    name: s.name,
    description: s.description ?? "",
    category: s.category ?? "",
    defaultPriceCents: canPrice ? s.defaultPriceCents : null,
    currency: s.currency,
    durationMinutes: s.durationMinutes,
    unitLabel: s.unitLabel ?? "item",
    active: Boolean(s.active),
  };
}

export async function listServices(user: CurrentUser, q: z.infer<typeof serviceListQuery>) {
  if (!user.permissions.has("services:read")) throw Errors.forbidden();
  await connectDb();
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(user.organizationId) };
  if (q.status !== "all") filter.active = q.status === "active";
  if (q.q) filter.searchName = { $regex: escapeRegex(q.q.toLowerCase()) };
  const [total, rows] = await Promise.all([
    Service.countDocuments(filter),
    Service.find(filter).sort({ active: -1, searchName: 1, _id: 1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
  ]);
  const canPrice = user.permissions.has("pricing:read");
  return { items: rows.map((r) => toServiceDTO(r, canPrice)), page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

/** Active services for booking forms (bounded). */
export async function activeServicesForBooking(user: CurrentUser): Promise<ServiceDTO[]> {
  if (!user.permissions.has("bookings:write")) throw Errors.forbidden();
  await connectDb();
  const rows = await Service.find({ organizationId: user.organizationId, active: true }).sort({ searchName: 1, _id: 1 }).limit(500).lean();
  return rows.map((r) => toServiceDTO(r, user.permissions.has("pricing:read")));
}

function assertCanWrite(user: CurrentUser) {
  // Prices are part of the catalog, so editing it requires seeing them.
  if (!user.permissions.has("services:write") || !user.permissions.has("pricing:read")) throw Errors.forbidden();
}

export async function createService(user: CurrentUser, raw: unknown) {
  assertCanWrite(user);
  const input = serviceInputSchema.parse(raw);
  await connectDb();
  const doc = await Service.create({
    organizationId: user.organizationId,
    ...input,
    searchName: input.name.toLowerCase(),
    currency: user.organization.currency,
  });
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "service.created", entityType: "service", entityId: doc._id, metadata: { name: input.name } });
  return toServiceDTO(doc.toObject(), true);
}

/**
 * Catalog edits never touch existing bookings — line items are snapshots.
 * Currency stays as created; changing the organization currency later does
 * not silently convert catalog prices.
 */
export async function updateService(user: CurrentUser, id: string, raw: unknown) {
  assertCanWrite(user);
  const input = serviceInputSchema.partial().strict().parse(raw);
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Service");
  await connectDb();
  const set: Record<string, unknown> = { ...input };
  if (input.name) set.searchName = input.name.toLowerCase();
  const doc = await Service.findOneAndUpdate({ _id: id, organizationId: user.organizationId }, { $set: set }, { returnDocument: "after", runValidators: true }).lean();
  if (!doc) throw Errors.notFound("Service");
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "service.updated", entityType: "service", entityId: doc._id, metadata: { fields: Object.keys(input) } });
  return toServiceDTO(doc, true);
}
