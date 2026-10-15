import "server-only";
import { randomInt } from "node:crypto";
import { Types, type ClientSession } from "mongoose";
import { Booking, type BookingDoc } from "@/lib/db/models/booking";
import { Customer } from "@/lib/db/models/customer";
import { formatCents } from "@/lib/domain/money";
import { localDateKey, zonedLocalToUtc } from "@/lib/domain/zoned-time";
import { AppError, Errors } from "@/lib/http/errors";

/**
 * Low-level ledger helpers used inside finance transactions. Every money
 * movement updates the authoritative record (receipt / refund / adjustment /
 * booking line) AND the shared contention records in one transaction:
 *   - Booking.ledgerRevision  (per booking: all its line balances)
 *   - Customer.ledgerRevision (per customer: outstanding, credit, points)
 *   - Payment.revision        (per receipt: allocations and refunds)
 * Two concurrent operations touching the same record write the same document,
 * so MongoDB aborts one with a write conflict; withTransaction retries it and
 * the retry re-validates against the new balances.
 */

export type LineDelta = { allocated?: number; adjustment?: number };

export function lineBalance(l: { chargedCents?: number | null; adjustmentCents?: number | null; allocatedCents?: number | null }) {
  return (l.chargedCents ?? 0) + (l.adjustmentCents ?? 0) - (l.allocatedCents ?? 0);
}

/**
 * Applies per-line deltas to one booking under its ledger revision and
 * checks the line invariants: allocated ≥ 0, effective charge ≥ 0, and
 * allocated ≤ effective charge (no overpayment, no credit below what's paid).
 * Returns the outstanding change for the customer.
 */
export async function applyLineDeltas(session: ClientSession, booking: BookingDoc, deltas: Map<string, LineDelta>): Promise<number> {
  const set: Record<string, number> = {};
  let outstandingDelta = 0;
  let allocatedTotal = booking.allocatedCents ?? 0;
  let adjustmentTotal = booking.adjustmentsCents ?? 0;
  for (const [lineId, d] of deltas) {
    const idx = booking.lineItems.findIndex((l) => String(l._id) === lineId);
    if (idx < 0) throw Errors.validation("A service line no longer exists on this booking.");
    const line = booking.lineItems[idx]!;
    const allocated = (line.allocatedCents ?? 0) + (d.allocated ?? 0);
    const adjustment = (line.adjustmentCents ?? 0) + (d.adjustment ?? 0);
    const effective = (line.chargedCents ?? 0) + adjustment;
    if (allocated < 0) throw new AppError(409, "LEDGER_INVARIANT", "This would make a line's paid amount negative.");
    if (effective < 0) throw new AppError(409, "CREDIT_EXCEEDS_CHARGE", `A credit can't exceed the charge for “${line.name}”.`);
    if (allocated > effective) {
      throw new AppError(409, d.allocated ? "LINE_OVERPAID" : "CREDIT_BELOW_PAID", d.allocated ? `“${line.name}” has only ${formatCents(Math.max(0, lineBalance(line)), booking.currency)} left to pay.` : `“${line.name}” is already paid beyond that amount. Refund or move the payment first.`, {
        lineItemId: lineId,
        remainingCents: Math.max(0, lineBalance(line)),
      });
    }
    set[`lineItems.${idx}.allocatedCents`] = allocated;
    set[`lineItems.${idx}.adjustmentCents`] = adjustment;
    outstandingDelta += (d.adjustment ?? 0) - (d.allocated ?? 0);
    allocatedTotal += d.allocated ?? 0;
    adjustmentTotal += d.adjustment ?? 0;
  }
  set.allocatedCents = allocatedTotal;
  set.adjustmentsCents = adjustmentTotal;
  const res = await Booking.updateOne(
    { _id: booking._id, organizationId: booking.organizationId, ledgerRevision: booking.ledgerRevision ?? 0 },
    { $set: set, $inc: { ledgerRevision: 1 } },
    { session },
  );
  if (res.matchedCount === 0) throw new AppError(409, "BUSY_RETRY", "This booking's balance changed at the same moment. Please try again.");
  return outstandingDelta;
}

/**
 * Updates a customer's derived balances. Negative deltas carry a $gte guard,
 * so a concurrent change can never drive outstanding, credit or points below
 * zero (the update simply doesn't match and the operation is refused).
 */
export async function applyCustomerDeltas(
  session: ClientSession,
  organizationId: Types.ObjectId,
  customerId: Types.ObjectId,
  d: { outstanding?: number; credit?: number; points?: number; lastPaymentAt?: Date },
): Promise<{ pointsBalance: number; creditCents: number; outstandingCents: number }> {
  const filter: Record<string, unknown> = { _id: customerId, organizationId };
  const inc: Record<string, number> = { ledgerRevision: 1 };
  const pairs: [keyof typeof d, string][] = [
    ["outstanding", "outstandingCents"],
    ["credit", "creditCents"],
    ["points", "pointsBalance"],
  ];
  for (const [k, field] of pairs) {
    const v = d[k] as number | undefined;
    if (!v) continue;
    inc[field] = v;
    if (v < 0) filter[field] = { $gte: -v };
  }
  const update: Record<string, unknown> = { $inc: inc };
  if (d.lastPaymentAt) update.$max = { lastPaymentAt: d.lastPaymentAt };
  const doc = await Customer.findOneAndUpdate(filter, update, { session, returnDocument: "after", projection: { pointsBalance: 1, creditCents: 1, outstandingCents: 1 } }).lean();
  if (!doc) {
    if (d.points && d.points < 0) throw new AppError(409, "INSUFFICIENT_POINTS", "The customer doesn't have enough points for that.");
    if (d.credit && d.credit < 0) throw new AppError(409, "INSUFFICIENT_CREDIT", "Not enough unallocated credit.");
    throw new AppError(409, "LEDGER_INVARIANT", "Customer balances changed at the same moment. Please try again.");
  }
  return { pointsBalance: doc.pointsBalance ?? 0, creditCents: doc.creditCents ?? 0, outstandingCents: doc.outstandingCents ?? 0 };
}

export async function loadOrgBooking(session: ClientSession, organizationId: Types.ObjectId, bookingId: string): Promise<BookingDoc> {
  if (!/^[a-f0-9]{24}$/i.test(bookingId)) throw Errors.notFound("Booking");
  const b = await Booking.findOne({ _id: bookingId, organizationId }).session(session).lean();
  if (!b) throw Errors.notFound("Booking");
  return b as BookingDoc;
}

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function randomCode(prefix: string, at: Date, tz: string) {
  let suffix = "";
  for (let i = 0; i < 5; i++) suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${prefix}-${localDateKey(at, tz).slice(2).replace(/-/g, "")}-${suffix}`;
}

/**
 * Converts a local transaction date/time to UTC. Receipts and refunds may not
 * be dated in the future. In the repeated hour at the end of daylight time
 * the earlier instant is used (documented; transaction times are informational).
 */
export function resolveTransactionTime(date: string, time: string, tz: string, now = new Date()): Date {
  const r = zonedLocalToUtc(date, time, tz, "earlier");
  if (!r.ok) {
    throw Errors.validation(r.reason === "NONEXISTENT" ? "That time is skipped by the daylight-saving change. Choose another time." : "Choose a valid date and time.");
  }
  if (r.instant.getTime() > now.getTime() + 5 * 60_000) throw Errors.validation("The date can't be in the future.");
  return r.instant;
}

export function oid(id: string | Types.ObjectId) {
  return typeof id === "string" ? new Types.ObjectId(id) : id;
}
