import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { withTransaction } from "@/lib/db/transaction";
import { Booking, type BookingDoc } from "@/lib/db/models/booking";
import { Customer } from "@/lib/db/models/customer";
import { Payment, type PaymentDoc } from "@/lib/db/models/payment";
import { Refund } from "@/lib/db/models/refund";
import { User } from "@/lib/db/models/user";
import { MAX_MONEY_CENTS, PAYMENT_METHODS, type PaymentMethod, type PaymentStatus } from "@/lib/domain/constants";
import { escapeRegex, OBJECT_ID_RE } from "@/lib/domain/normalize";
import { isDateKey, localDaysRange } from "@/lib/domain/zoned-time";
import { AppError, Errors } from "@/lib/http/errors";
import { recordActivity } from "@/modules/activities/service";
import { recordAudit } from "@/modules/audit/service";
import { applyCustomerDeltas, applyLineDeltas, lineBalance, loadOrgBooking, oid, randomCode, resolveTransactionTime } from "./ledger";

const objectId = z.string().regex(OBJECT_ID_RE, "Invalid id");
const idemKey = z.string().regex(/^[A-Za-z0-9_-]{16,100}$/, "Invalid request key");
const money = z.number().int("Use whole cents").min(1, "Amount must be positive").max(MAX_MONEY_CENTS, "Amount is too large");
const dateKey = z.string().refine(isDateKey, "Choose a valid date");
const timeKey = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a valid time");

const allocationInput = z.object({ bookingId: objectId, lineItemId: objectId, amountCents: money }).strict();

export const recordPaymentSchema = z
  .object({
    idempotencyKey: idemKey,
    customerId: objectId,
    amountCents: money,
    /** Must equal the organization currency (no conversions). */
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    receivedDate: dateKey,
    receivedTime: timeKey,
    method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().max(120).default(""),
    note: z.string().trim().max(2000).default(""),
    allocations: z.array(allocationInput).max(200).default([]),
  })
  .strict();

export const allocateCreditSchema = z.object({ expectedRevision: z.number().int().min(0), allocations: z.array(allocationInput).min(1).max(200) }).strict();

export const refundSchema = z
  .object({
    idempotencyKey: idemKey,
    amountCents: money,
    refundedDate: dateKey,
    refundedTime: timeKey,
    reason: z.string().trim().min(3, "Give a reason").max(1000),
    reference: z.string().trim().max(120).default(""),
    /** Which parts are refunded: an allocation id, or null for unallocated credit. Omit for the default order. */
    portions: z.array(z.object({ allocationId: objectId.nullable(), amountCents: money }).strict()).max(200).optional(),
  })
  .strict();

export const reverseSchema = z.object({ expectedRevision: z.number().int().min(0), reason: z.string().trim().min(3, "Give a reason").max(1000) }).strict();

type AllocInput = z.infer<typeof allocationInput>;

function assertNoDuplicates(allocs: AllocInput[]) {
  const seen = new Set<string>();
  for (const a of allocs) {
    const k = `${a.bookingId}:${a.lineItemId}`;
    if (seen.has(k)) throw Errors.validation("Each service line can appear only once per allocation.");
    seen.add(k);
  }
}

/**
 * Applies allocations to finalized lines of the customer's bookings inside a
 * transaction. Rejects other customers' bookings, draft charges and any
 * amount above a line's remaining balance. Returns stored allocation docs.
 */
async function applyAllocations(
  session: import("mongoose").ClientSession,
  orgId: Types.ObjectId,
  customerId: Types.ObjectId,
  allocs: AllocInput[],
  actorId: string,
  source: "receipt" | "credit",
  at: Date,
) {
  const byBooking = new Map<string, AllocInput[]>();
  for (const a of allocs) byBooking.set(a.bookingId, [...(byBooking.get(a.bookingId) ?? []), a]);
  const stored = [];
  let outstandingDelta = 0;
  // Stable order so concurrent transactions touch bookings in the same sequence.
  for (const bookingId of [...byBooking.keys()].sort()) {
    const b: BookingDoc = await loadOrgBooking(session, orgId, bookingId);
    if (!b.customerId.equals(customerId)) throw new AppError(403, "OTHER_CUSTOMER", "That booking belongs to a different customer.");
    if (b.billingState !== "FINALIZED") throw new AppError(409, "NOT_FINALIZED", `Booking ${b.reference} has no finalized charges yet. Finalize it first (deposits are fine for scheduled work).`);
    const deltas = new Map<string, { allocated: number }>();
    for (const a of byBooking.get(bookingId)!) {
      const line = b.lineItems.find((l) => String(l._id) === a.lineItemId);
      if (!line) throw Errors.validation(`Service line not found on booking ${b.reference}.`);
      deltas.set(a.lineItemId, { allocated: a.amountCents });
      stored.push({ _id: new Types.ObjectId(), bookingId: b._id, lineItemId: line._id, serviceId: line.serviceId, amountCents: a.amountCents, refundedCents: 0, allocatedAt: at, allocatedBy: oid(actorId), source });
    }
    outstandingDelta += await applyLineDeltas(session, b, deltas);
  }
  return { stored, outstandingDelta };
}

export async function recordPayment(user: CurrentUser, raw: unknown) {
  if (!user.permissions.has("payments:record")) throw Errors.forbidden();
  const input = recordPaymentSchema.parse(raw);
  if (input.currency && input.currency !== user.organization.currency) {
    throw new AppError(409, "CURRENCY_MISMATCH", `Payments must be in ${user.organization.currency}. Currency conversion isn't supported.`);
  }
  assertNoDuplicates(input.allocations);
  const allocatedTotal = input.allocations.reduce((s, a) => s + a.amountCents, 0);
  if (allocatedTotal > input.amountCents) throw Errors.validation("Allocations add up to more than the amount received.");
  await connectDb();
  const orgId = oid(user.organizationId);
  const findExisting = () => Payment.findOne({ organizationId: orgId, idempotencyKey: input.idempotencyKey }).lean();
  const replay = await findExisting();
  if (replay) return { id: String(replay._id), created: false };
  const receivedAt = resolveTransactionTime(input.receivedDate, input.receivedTime, user.organization.timezone);
  const customerId = oid(input.customerId);
  let paymentId!: Types.ObjectId;
  try {
    paymentId = await withTransaction(async (session) => {
      const customer = await Customer.findOne({ _id: customerId, organizationId: orgId }).select("_id name").session(session).lean();
      if (!customer) throw Errors.notFound("Customer");
      const { stored, outstandingDelta } = await applyAllocations(session, orgId, customerId, input.allocations, user.id, "receipt", new Date());
      const unallocated = input.amountCents - allocatedTotal;
      const [p] = await Payment.create(
        [
          {
            organizationId: orgId,
            customerId,
            receiptNumber: randomCode("PMT", receivedAt, user.organization.timezone),
            amountCents: input.amountCents,
            currency: user.organization.currency,
            receivedAt,
            method: input.method,
            reference: input.reference,
            note: input.note,
            allocations: stored,
            netAllocatedCents: allocatedTotal,
            unallocatedCents: unallocated,
            idempotencyKey: input.idempotencyKey,
            createdBy: oid(user.id),
          },
        ],
        { session },
      );
      await applyCustomerDeltas(session, orgId, customerId, { outstanding: outstandingDelta, credit: unallocated, lastPaymentAt: receivedAt });
      await recordActivity({ organizationId: orgId, actorId: user.id, type: "payment.recorded", customerId, metadata: { receipt: p!.receiptNumber, amountCents: input.amountCents, allocatedCents: allocatedTotal, method: input.method } }, session);
      await recordAudit({ organizationId: orgId, actorId: user.id, action: "payment.recorded", entityType: "payment", entityId: p!._id, metadata: { receipt: p!.receiptNumber, amountCents: input.amountCents, allocatedCents: allocatedTotal } }, session);
      return p!._id;
    });
  } catch (err) {
    // A concurrent retry with the same key: return the receipt that won.
    if ((err as { code?: number }).code === 11000) {
      const existing = await findExisting();
      if (existing) return { id: String(existing._id), created: false };
    }
    throw err;
  }
  return { id: String(paymentId), created: true };
}

async function loadPaymentTx(session: import("mongoose").ClientSession, orgId: Types.ObjectId, paymentId: string) {
  if (!OBJECT_ID_RE.test(paymentId)) throw Errors.notFound("Payment");
  const p = await Payment.findOne({ _id: paymentId, organizationId: orgId }).session(session).lean();
  if (!p) throw Errors.notFound("Payment");
  return p as PaymentDoc;
}

function staleReceipt() {
  return new AppError(409, "STALE_VERSION", "This payment changed since you opened it. Reload and try again.");
}

/** Applies part of a receipt's unallocated credit to finalized lines of the same customer. */
export async function allocateCredit(user: CurrentUser, paymentId: string, raw: unknown) {
  if (!user.permissions.has("payments:allocate")) throw Errors.forbidden();
  const input = allocateCreditSchema.parse(raw);
  assertNoDuplicates(input.allocations);
  const total = input.allocations.reduce((s, a) => s + a.amountCents, 0);
  await connectDb();
  const orgId = oid(user.organizationId);
  await withTransaction(async (session) => {
    const p = await loadPaymentTx(session, orgId, paymentId);
    if (p.revision !== input.expectedRevision) throw staleReceipt();
    if (p.status !== "POSTED") throw new AppError(409, "REVERSED", "This receipt was reversed.");
    if (total > p.unallocatedCents) throw new AppError(409, "INSUFFICIENT_CREDIT", "That's more than the unallocated amount on this receipt.");
    const { stored, outstandingDelta } = await applyAllocations(session, orgId, p.customerId, input.allocations, user.id, "credit", new Date());
    const res = await Payment.updateOne(
      { _id: p._id, revision: p.revision, unallocatedCents: { $gte: total } },
      { $push: { allocations: { $each: stored } }, $inc: { netAllocatedCents: total, unallocatedCents: -total, revision: 1 } },
      { session },
    );
    if (res.matchedCount === 0) throw staleReceipt();
    await applyCustomerDeltas(session, orgId, p.customerId, { outstanding: outstandingDelta, credit: -total });
    await recordActivity({ organizationId: orgId, actorId: user.id, type: "credit.applied", customerId: p.customerId, metadata: { receipt: p.receiptNumber, amountCents: total } }, session);
    await recordAudit({ organizationId: orgId, actorId: user.id, action: "payment.credit_applied", entityType: "payment", entityId: p._id, metadata: { receipt: p.receiptNumber, amountCents: total } }, session);
  });
  return { ok: true };
}

/**
 * Records a refund already processed outside RealtyPacer. Refunding an
 * allocated portion reduces what's paid on that line (outstanding can rise
 * again); refunding unallocated funds reduces customer credit. Default order:
 * unallocated credit first, then the most recent allocations.
 */
export async function recordRefund(user: CurrentUser, paymentId: string, raw: unknown) {
  if (!user.permissions.has("payments:refund")) throw Errors.forbidden();
  const input = refundSchema.parse(raw);
  await connectDb();
  const orgId = oid(user.organizationId);
  const findExisting = () => Refund.findOne({ organizationId: orgId, idempotencyKey: input.idempotencyKey }).lean();
  const replay = await findExisting();
  if (replay) return { id: String(replay._id), created: false };
  const refundedAt = resolveTransactionTime(input.refundedDate, input.refundedTime, user.organization.timezone);
  let refundId!: Types.ObjectId;
  try {
    refundId = await withTransaction(async (session) => {
      const p = await loadPaymentTx(session, orgId, paymentId);
      if (p.status !== "POSTED") throw new AppError(409, "REVERSED", "This receipt was reversed; there is nothing to refund.");
      if (refundedAt < p.receivedAt) throw Errors.validation("A refund can't be dated before the payment was received.");
      const refundable = p.amountCents - p.refundedCents;
      if (input.amountCents > refundable) throw new AppError(409, "REFUND_EXCEEDS_RECEIPT", `At most ${refundable} cents of this receipt can still be refunded.`, { refundableCents: refundable });

      // Resolve portions (explicit or default order).
      const remainingByAlloc = new Map(p.allocations.map((a) => [String(a._id), a.amountCents - (a.refundedCents ?? 0)]));
      let portions: { allocationId: string | null; amountCents: number }[];
      if (input.portions?.length) {
        portions = input.portions;
        if (portions.reduce((s, x) => s + x.amountCents, 0) !== input.amountCents) throw Errors.validation("Refund portions must add up to the refund amount.");
      } else {
        portions = [];
        let left = input.amountCents;
        const fromCredit = Math.min(left, p.unallocatedCents);
        if (fromCredit > 0) portions.push({ allocationId: null, amountCents: fromCredit });
        left -= fromCredit;
        for (const a of [...p.allocations].reverse()) {
          if (left <= 0) break;
          const take = Math.min(left, remainingByAlloc.get(String(a._id)) ?? 0);
          if (take > 0) portions.push({ allocationId: String(a._id), amountCents: take });
          left -= take;
        }
      }
      const fromUnallocated = portions.filter((x) => x.allocationId === null).reduce((s, x) => s + x.amountCents, 0);
      if (fromUnallocated > p.unallocatedCents) throw new AppError(409, "REFUND_EXCEEDS_CREDIT", "That's more than the unallocated part of this receipt.");
      const perAlloc = new Map<string, number>();
      for (const x of portions) if (x.allocationId) perAlloc.set(x.allocationId, (perAlloc.get(x.allocationId) ?? 0) + x.amountCents);
      for (const [id, amt] of perAlloc) {
        if (!remainingByAlloc.has(id)) throw Errors.validation("A refund portion refers to an allocation that isn't on this receipt.");
        if (amt > remainingByAlloc.get(id)!) throw new AppError(409, "REFUND_EXCEEDS_ALLOCATION", "A refund portion is larger than what remains of that allocation.");
      }

      // Reduce paid amounts on the affected lines (grouped per booking).
      const byBooking = new Map<string, Map<string, { allocated: number }>>();
      const storedPortions = portions.map((x) => {
        const a = x.allocationId ? p.allocations.find((al) => String(al._id) === x.allocationId)! : null;
        if (a) {
          const m = byBooking.get(String(a.bookingId)) ?? new Map();
          const cur = m.get(String(a.lineItemId))?.allocated ?? 0;
          m.set(String(a.lineItemId), { allocated: cur - x.amountCents });
          byBooking.set(String(a.bookingId), m);
        }
        return { allocationId: a?._id ?? null, bookingId: a?.bookingId ?? null, lineItemId: a?.lineItemId ?? null, serviceId: a?.serviceId ?? null, amountCents: x.amountCents };
      });
      let outstandingDelta = 0;
      for (const bookingId of [...byBooking.keys()].sort()) {
        const b = await loadOrgBooking(session, orgId, bookingId);
        outstandingDelta += await applyLineDeltas(session, b, byBooking.get(bookingId)!);
      }
      const inc: Record<string, number> = { refundedCents: input.amountCents, netAllocatedCents: -(input.amountCents - fromUnallocated), unallocatedCents: -fromUnallocated, revision: 1 };
      const update: Record<string, unknown> = { $inc: inc };
      const arrayFilters: Record<string, unknown>[] = [];
      let n = 0;
      for (const [id, amt] of perAlloc) {
        inc[`allocations.$[a${n}].refundedCents`] = amt;
        arrayFilters.push({ [`a${n}._id`]: new Types.ObjectId(id) });
        n++;
      }
      const res = await Payment.updateOne({ _id: p._id, revision: p.revision }, update, { session, arrayFilters });
      if (res.matchedCount === 0) throw staleReceipt();
      const [r] = await Refund.create(
        [{ organizationId: orgId, customerId: p.customerId, paymentId: p._id, amountCents: input.amountCents, currency: p.currency, refundedAt, reason: input.reason, reference: input.reference, portions: storedPortions, idempotencyKey: input.idempotencyKey, createdBy: oid(user.id) }],
        { session },
      );
      await applyCustomerDeltas(session, orgId, p.customerId, { outstanding: outstandingDelta, credit: -fromUnallocated });
      await recordActivity({ organizationId: orgId, actorId: user.id, type: "payment.refunded", customerId: p.customerId, content: input.reason, metadata: { receipt: p.receiptNumber, amountCents: input.amountCents } }, session);
      await recordAudit({ organizationId: orgId, actorId: user.id, action: "payment.refund_recorded", entityType: "payment", entityId: p._id, metadata: { receipt: p.receiptNumber, amountCents: input.amountCents } }, session);
      return r!._id;
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const existing = await findExisting();
      if (existing) return { id: String(existing._id), created: false };
    }
    throw err;
  }
  return { id: String(refundId), created: true };
}

/**
 * Corrects a receipt recorded by mistake: status → REVERSED, its allocations
 * stop counting, nothing is deleted. Receipts with refunds can't be reversed
 * (record the correction as a refund instead). Record a replacement receipt
 * afterwards if needed.
 */
export async function reversePayment(user: CurrentUser, paymentId: string, raw: unknown) {
  if (!user.permissions.has("payments:refund")) throw Errors.forbidden();
  const input = reverseSchema.parse(raw);
  await connectDb();
  const orgId = oid(user.organizationId);
  await withTransaction(async (session) => {
    const p = await loadPaymentTx(session, orgId, paymentId);
    if (p.revision !== input.expectedRevision) throw staleReceipt();
    if (p.status !== "POSTED") throw new AppError(409, "REVERSED", "This receipt is already reversed.");
    if (p.refundedCents > 0) throw new AppError(409, "HAS_REFUNDS", "This receipt has refunds recorded against it and can't be reversed.");
    const byBooking = new Map<string, Map<string, { allocated: number }>>();
    for (const a of p.allocations) {
      const net = a.amountCents - (a.refundedCents ?? 0);
      if (net <= 0) continue;
      const m = byBooking.get(String(a.bookingId)) ?? new Map();
      m.set(String(a.lineItemId), { allocated: (m.get(String(a.lineItemId))?.allocated ?? 0) - net });
      byBooking.set(String(a.bookingId), m);
    }
    let outstandingDelta = 0;
    for (const bookingId of [...byBooking.keys()].sort()) {
      const b = await loadOrgBooking(session, orgId, bookingId);
      outstandingDelta += await applyLineDeltas(session, b, byBooking.get(bookingId)!);
    }
    const res = await Payment.updateOne(
      { _id: p._id, revision: p.revision, status: "POSTED" },
      { $set: { status: "REVERSED", reversedAt: new Date(), reversedBy: oid(user.id), reversalReason: input.reason, netAllocatedCents: 0, unallocatedCents: 0 }, $inc: { revision: 1 } },
      { session },
    );
    if (res.matchedCount === 0) throw staleReceipt();
    await applyCustomerDeltas(session, orgId, p.customerId, { outstanding: outstandingDelta, credit: -p.unallocatedCents });
    await recordActivity({ organizationId: orgId, actorId: user.id, type: "payment.reversed", customerId: p.customerId, content: input.reason, metadata: { receipt: p.receiptNumber, amountCents: p.amountCents } }, session);
    await recordAudit({ organizationId: orgId, actorId: user.id, action: "payment.reversed", entityType: "payment", entityId: p._id, metadata: { receipt: p.receiptNumber, amountCents: p.amountCents } }, session);
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type PaymentRow = {
  id: string;
  receiptNumber: string;
  customer: { id: string; name: string };
  amountCents: number;
  currency: string;
  receivedAt: string;
  method: PaymentMethod;
  reference: string;
  status: PaymentStatus;
  appliedCents: number;
  unallocatedCents: number;
  refundedCents: number;
  refundState: "none" | "partial" | "full";
};

export const paymentListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  customerId: objectId.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(["POSTED", "REVERSED"]).optional(),
  from: dateKey.optional(),
  to: dateKey.optional(),
  unallocated: z.enum(["1"]).optional(),
  refunded: z.enum(["1"]).optional(),
  sort: z.enum(["receivedAt", "amountCents"]).default("receivedAt"),
  dir: z.enum(["asc", "desc"]).default("desc"),
});

function toRow(p: PaymentDoc, name: string): PaymentRow {
  const net = p.amountCents - (p.refundedCents ?? 0);
  return {
    id: String(p._id),
    receiptNumber: p.receiptNumber,
    customer: { id: String(p.customerId), name },
    amountCents: p.amountCents,
    currency: p.currency,
    receivedAt: p.receivedAt.toISOString(),
    method: p.method as PaymentMethod,
    reference: p.reference ?? "",
    status: p.status as PaymentStatus,
    appliedCents: p.netAllocatedCents ?? 0,
    unallocatedCents: p.unallocatedCents ?? 0,
    refundedCents: p.refundedCents ?? 0,
    refundState: !p.refundedCents ? "none" : net === 0 ? "full" : "partial",
  };
}

export async function listPayments(user: CurrentUser, q: z.infer<typeof paymentListQuery>) {
  if (!user.permissions.has("financials:read")) throw Errors.forbidden();
  await connectDb();
  const orgId = oid(user.organizationId);
  const filter: Record<string, unknown> = { organizationId: orgId };
  if (q.customerId) filter.customerId = oid(q.customerId);
  if (q.method) filter.method = q.method;
  if (q.status) filter.status = q.status;
  if (q.unallocated) filter.unallocatedCents = { $gt: 0 };
  if (q.refunded) filter.refundedCents = { $gt: 0 };
  if (q.from || q.to) {
    const r = localDaysRange(q.from ?? q.to!, q.to ?? q.from!, user.organization.timezone);
    filter.receivedAt = { $gte: r.start, $lt: r.end };
  }
  if (q.q) {
    const re = { $regex: escapeRegex(q.q.toLowerCase()) };
    const custs = await Customer.find({ organizationId: orgId, searchName: re }).select("_id").limit(200).lean();
    filter.$or = [{ receiptNumber: { $regex: `^${escapeRegex(q.q.toUpperCase())}` } }, { reference: { $regex: escapeRegex(q.q), $options: "i" } }, { customerId: { $in: custs.map((c) => c._id) } }];
  }
  const dir = q.dir === "asc" ? 1 : -1;
  const [total, rows, totals] = await Promise.all([
    Payment.countDocuments(filter),
    Payment.find(filter).sort({ [q.sort]: dir, _id: dir }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
    Payment.aggregate<{ amount: number; refunded: number; applied: number; unallocated: number }>([
      { $match: { ...filter, status: q.status ?? "POSTED" } },
      { $group: { _id: null, amount: { $sum: "$amountCents" }, refunded: { $sum: "$refundedCents" }, applied: { $sum: "$netAllocatedCents" }, unallocated: { $sum: "$unallocatedCents" } } },
    ]),
  ]);
  const names = new Map((await Customer.find({ _id: { $in: rows.map((r) => r.customerId) } }).select("name").lean()).map((c) => [String(c._id), c.name]));
  const t = totals[0];
  return {
    items: rows.map((r) => toRow(r as PaymentDoc, names.get(String(r.customerId)) ?? "—")),
    totals: { receiptsCents: t?.amount ?? 0, refundsCents: t?.refunded ?? 0, netReceivedCents: (t?.amount ?? 0) - (t?.refunded ?? 0), appliedCents: t?.applied ?? 0, unallocatedCents: t?.unallocated ?? 0, basis: "Receipt date; reversed receipts excluded unless filtered" },
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

export async function getPayment(user: CurrentUser, id: string) {
  if (!user.permissions.has("financials:read")) throw Errors.forbidden();
  await connectDb();
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Payment");
  const p = (await Payment.findOne({ _id: id, organizationId: user.organizationId }).lean()) as PaymentDoc | null;
  if (!p) throw Errors.notFound("Payment");
  const [customer, refunds, bookings] = await Promise.all([
    Customer.findById(p.customerId).select("name phoneDisplay email").lean(),
    Refund.find({ organizationId: user.organizationId, paymentId: p._id }).sort({ refundedAt: 1 }).lean(),
    Booking.find({ _id: { $in: [...new Set(p.allocations.map((a) => String(a.bookingId)))] }, organizationId: user.organizationId }).select("reference scheduledStartAt lineItems._id lineItems.name addressSnapshot.city").lean(),
  ]);
  const actorIds = [...new Set([p.createdBy, p.reversedBy, ...refunds.map((r) => r.createdBy)].filter(Boolean).map(String))];
  const actors = new Map((await User.find({ _id: { $in: actorIds }, organizationId: user.organizationId }).select("name").lean()).map((u) => [String(u._id), u.name]));
  const bookingById = new Map(bookings.map((b) => [String(b._id), b]));
  return {
    ...toRow(p, customer?.name ?? "—"),
    revision: p.revision,
    note: p.note ?? "",
    customerContact: { phoneDisplay: customer?.phoneDisplay ?? null, email: customer?.email ?? null },
    recordedBy: p.createdBy ? (actors.get(String(p.createdBy)) ?? "Former user") : null,
    recordedAt: (p as unknown as { createdAt: Date }).createdAt.toISOString(),
    reversal: p.status === "REVERSED" ? { at: p.reversedAt?.toISOString() ?? null, by: p.reversedBy ? (actors.get(String(p.reversedBy)) ?? "Former user") : null, reason: p.reversalReason ?? "" } : null,
    allocations: p.allocations.map((a) => {
      const b = bookingById.get(String(a.bookingId));
      return {
        id: String(a._id),
        bookingId: String(a.bookingId),
        bookingReference: b?.reference ?? "—",
        serviceDate: b?.scheduledStartAt?.toISOString() ?? null,
        city: b?.addressSnapshot?.city ?? "",
        lineItemId: String(a.lineItemId),
        lineName: b?.lineItems.find((l) => String(l._id) === String(a.lineItemId))?.name ?? "Service",
        amountCents: a.amountCents,
        refundedCents: a.refundedCents ?? 0,
        source: a.source,
        allocatedAt: a.allocatedAt.toISOString(),
      };
    }),
    refunds: refunds.map((r) => ({ id: String(r._id), amountCents: r.amountCents, refundedAt: r.refundedAt.toISOString(), reason: r.reason, reference: r.reference ?? "", by: r.createdBy ? (actors.get(String(r.createdBy)) ?? "Former user") : null, portions: r.portions.map((x) => ({ allocationId: x.allocationId ? String(x.allocationId) : null, amountCents: x.amountCents })) })),
  };
}

export type OpenCharge = {
  bookingId: string;
  reference: string;
  serviceDate: string;
  status: string;
  lines: { lineItemId: string; name: string; chargedCents: number; adjustmentCents: number; paidCents: number; balanceCents: number }[];
  balanceCents: number;
};

/** A customer's finalized bookings with something still owed, oldest service date first. */
export async function openCharges(user: CurrentUser, customerId: string): Promise<OpenCharge[]> {
  if (!user.permissions.has("financials:read")) throw Errors.forbidden();
  await connectDb();
  if (!OBJECT_ID_RE.test(customerId)) throw Errors.notFound("Customer");
  const rows = await Booking.find({ organizationId: user.organizationId, customerId, billingState: "FINALIZED" })
    .select("reference scheduledStartAt status lineItems")
    .sort({ scheduledStartAt: 1, _id: 1 })
    .limit(300)
    .lean();
  return rows
    .map((b) => {
      const lines = b.lineItems.map((l) => ({ lineItemId: String(l._id), name: l.name, chargedCents: l.chargedCents ?? 0, adjustmentCents: l.adjustmentCents ?? 0, paidCents: l.allocatedCents ?? 0, balanceCents: lineBalance(l) }));
      return { bookingId: String(b._id), reference: b.reference, serviceDate: b.scheduledStartAt.toISOString(), status: b.status, lines, balanceCents: lines.reduce((s, l) => s + l.balanceCents, 0) };
    })
    .filter((b) => b.balanceCents > 0);
}
