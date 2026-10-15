import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { withTransaction } from "@/lib/db/transaction";
import { Customer } from "@/lib/db/models/customer";
import { LoyaltyEntry } from "@/lib/db/models/loyalty-entry";
import { User } from "@/lib/db/models/user";
import { MAX_POINTS_CHANGE, type LoyaltyEntryType } from "@/lib/domain/constants";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { AppError, Errors } from "@/lib/http/errors";
import { recordActivity } from "@/modules/activities/service";
import { recordAudit } from "@/modules/audit/service";
import { applyCustomerDeltas } from "@/modules/finance/ledger";

const objectId = z.string().regex(OBJECT_ID_RE);
const points = z.number().int("Use whole points").min(1).max(MAX_POINTS_CHANGE);

/**
 * grant: +points · redeem: −points (records usage only; any money discount is
 * a separate, authorized billing action) · correction: ± with reason ·
 * reversal: undoes one earlier entry exactly once.
 */
export const loyaltyEntrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("grant"), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/), points, reason: z.string().trim().min(3).max(500), bookingId: objectId.optional() }).strict(),
  z.object({ type: z.literal("redeem"), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/), points, reason: z.string().trim().min(3).max(500), bookingId: objectId.optional() }).strict(),
  z.object({ type: z.literal("correction"), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/), pointsChange: z.number().int().min(-MAX_POINTS_CHANGE).max(MAX_POINTS_CHANGE).refine((v) => v !== 0, "Enter a non-zero change"), reason: z.string().trim().min(3).max(500) }).strict(),
  z.object({ type: z.literal("reversal"), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/), entryId: objectId, reason: z.string().trim().min(3).max(500) }).strict(),
]);

export async function addLoyaltyEntry(user: CurrentUser, customerId: string, raw: unknown) {
  if (!user.permissions.has("loyalty:adjust")) throw Errors.forbidden();
  const input = loyaltyEntrySchema.parse(raw);
  if (!OBJECT_ID_RE.test(customerId)) throw Errors.notFound("Customer");
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  const cid = new Types.ObjectId(customerId);
  const existing = await LoyaltyEntry.findOne({ organizationId: orgId, idempotencyKey: input.idempotencyKey }).lean();
  if (existing) return { id: String(existing._id), balance: existing.balanceAfter, created: false };
  let result!: { id: string; balance: number };
  try {
    result = await withTransaction(async (session) => {
      if (!(await Customer.exists({ _id: cid, organizationId: orgId }).session(session))) throw Errors.notFound("Customer");
      let change: number;
      let reversesEntryId: Types.ObjectId | null = null;
      let type: LoyaltyEntryType = input.type;
      if (input.type === "grant") change = input.points;
      else if (input.type === "redeem") change = -input.points;
      else if (input.type === "correction") change = input.pointsChange;
      else {
        const target = await LoyaltyEntry.findOne({ _id: input.entryId, organizationId: orgId, customerId: cid }).session(session).lean();
        if (!target) throw Errors.notFound("Points entry");
        if (target.type === "reversal") throw new AppError(409, "CANNOT_REVERSE_REVERSAL", "A reversal can't itself be reversed; add a correction instead.");
        if (await LoyaltyEntry.exists({ organizationId: orgId, reversesEntryId: target._id }).session(session)) throw new AppError(409, "ALREADY_REVERSED", "That entry was already reversed.");
        change = -target.pointsChange;
        reversesEntryId = target._id;
        type = "reversal";
      }
      // Guarded $inc: concurrent redemptions can never take the balance below zero.
      const balances = await applyCustomerDeltas(session, orgId, cid, { points: change });
      const [entry] = await LoyaltyEntry.create(
        [{ organizationId: orgId, customerId: cid, type, pointsChange: change, balanceAfter: balances.pointsBalance, reason: input.reason, reference: "bookingId" in input && input.bookingId ? { type: "booking", id: new Types.ObjectId(input.bookingId) } : { type: "manual" }, reversesEntryId, idempotencyKey: input.idempotencyKey, createdBy: new Types.ObjectId(user.id) }],
        { session },
      );
      await recordActivity({ organizationId: orgId, actorId: user.id, type: "points.changed", customerId: cid, content: input.reason, metadata: { entryType: type, pointsChange: change, balance: balances.pointsBalance } }, session);
      await recordAudit({ organizationId: orgId, actorId: user.id, action: "loyalty.changed", entityType: "customer", entityId: cid, metadata: { entryType: type, pointsChange: change } }, session);
      return { id: String(entry!._id), balance: balances.pointsBalance };
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const again = await LoyaltyEntry.findOne({ organizationId: orgId, idempotencyKey: input.idempotencyKey }).lean();
      if (again) return { id: String(again._id), balance: again.balanceAfter, created: false };
      throw new AppError(409, "ALREADY_REVERSED", "That entry was already reversed.");
    }
    throw err;
  }
  return { ...result, created: true };
}

export async function loyaltyHistory(user: CurrentUser, customerId: string, page = 1, pageSize = 25) {
  if (!user.permissions.has("loyalty:read")) throw Errors.forbidden();
  if (!OBJECT_ID_RE.test(customerId)) throw Errors.notFound("Customer");
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  const customer = await Customer.findOne({ _id: customerId, organizationId: orgId }).select("pointsBalance").lean();
  if (!customer) throw Errors.notFound("Customer");
  const filter = { organizationId: orgId, customerId: new Types.ObjectId(customerId) };
  const [total, rows] = await Promise.all([LoyaltyEntry.countDocuments(filter), LoyaltyEntry.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean()]);
  const reversed = new Set((await LoyaltyEntry.find({ ...filter, reversesEntryId: { $in: rows.map((r) => r._id) } }).select("reversesEntryId").lean()).map((r) => String(r.reversesEntryId)));
  const actors = new Map((await User.find({ _id: { $in: rows.map((r) => r.createdBy).filter(Boolean) }, organizationId: orgId }).select("name").lean()).map((u) => [String(u._id), u.name]));
  return {
    balance: customer.pointsBalance ?? 0,
    items: rows.map((r) => ({ id: String(r._id), type: r.type as LoyaltyEntryType, pointsChange: r.pointsChange, balanceAfter: r.balanceAfter, reason: r.reason, occurredAt: r.occurredAt.toISOString(), by: r.createdBy ? (actors.get(String(r.createdBy)) ?? "Former user") : null, reversed: reversed.has(String(r._id)), reversesEntryId: r.reversesEntryId ? String(r.reversesEntryId) : null })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
