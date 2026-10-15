import "server-only";
import { Types } from "mongoose";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Booking } from "@/lib/db/models/booking";
import { ChargeAdjustment } from "@/lib/db/models/charge-adjustment";
import { Customer } from "@/lib/db/models/customer";
import { LoyaltyEntry } from "@/lib/db/models/loyalty-entry";
import { Payment } from "@/lib/db/models/payment";
import { Refund } from "@/lib/db/models/refund";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { Errors } from "@/lib/http/errors";

/**
 * Lifetime financial summary for one customer, computed from the
 * authoritative records (finalized booking lines, charge adjustments,
 * receipts, refunds) — never from the derived balance fields.
 */
export type CustomerFinancialSummary = {
  currency: string;
  basis: "lifetime";
  finalizedChargesCents: number; // Σ charged on FINALIZED bookings (net + tax)
  adjustmentsCents: number; // Σ charge adjustments (negative = credits)
  chargesAfterAdjustmentsCents: number;
  grossReceiptsCents: number; // Σ POSTED receipts
  refundsCents: number; // Σ refunds on POSTED receipts
  netReceivedCents: number; // receipts − refunds
  netAllocatedCents: number; // Σ allocations − refunded portions
  outstandingCents: number; // charges after adjustments − net allocated
  unallocatedCreditCents: number; // net received − net allocated
  pointsBalance: number;
  lastPaymentAt: string | null;
  draftEstimateCents: number; // DRAFT bookings (not owed) — shown separately
};

export async function computeCustomerFinancials(organizationId: Types.ObjectId, customerId: Types.ObjectId, currency: string): Promise<CustomerFinancialSummary> {
  const [charges, drafts, adj, pay, points] = await Promise.all([
    Booking.aggregate<{ charged: number }>([
      { $match: { organizationId, customerId, billingState: "FINALIZED" } },
      { $group: { _id: null, charged: { $sum: "$chargedCents" } } },
    ]),
    Booking.aggregate<{ net: number }>([
      { $match: { organizationId, customerId, billingState: "DRAFT", status: { $ne: "CANCELLED" } } },
      { $group: { _id: null, net: { $sum: "$chargedCents" } } },
    ]),
    ChargeAdjustment.aggregate<{ total: number }>([{ $match: { organizationId, customerId } }, { $group: { _id: null, total: { $sum: "$amountCents" } } }]),
    Payment.aggregate<{ amount: number; refunded: number; allocated: number; last: Date | null }>([
      { $match: { organizationId, customerId, status: "POSTED" } },
      {
        $group: {
          _id: null,
          amount: { $sum: "$amountCents" },
          refunded: { $sum: "$refundedCents" },
          allocated: {
            $sum: { $sum: { $map: { input: "$allocations", as: "a", in: { $subtract: ["$$a.amountCents", { $ifNull: ["$$a.refundedCents", 0] }] } } } },
          },
          last: { $max: "$receivedAt" },
        },
      },
    ]),
    LoyaltyEntry.aggregate<{ total: number }>([{ $match: { organizationId, customerId } }, { $group: { _id: null, total: { $sum: "$pointsChange" } } }]),
  ]);
  const finalized = charges[0]?.charged ?? 0;
  const adjustments = adj[0]?.total ?? 0;
  const receipts = pay[0]?.amount ?? 0;
  const refunds = pay[0]?.refunded ?? 0;
  const allocated = pay[0]?.allocated ?? 0;
  return {
    currency,
    basis: "lifetime",
    finalizedChargesCents: finalized,
    adjustmentsCents: adjustments,
    chargesAfterAdjustmentsCents: finalized + adjustments,
    grossReceiptsCents: receipts,
    refundsCents: refunds,
    netReceivedCents: receipts - refunds,
    netAllocatedCents: allocated,
    outstandingCents: finalized + adjustments - allocated,
    unallocatedCreditCents: receipts - refunds - allocated,
    pointsBalance: points[0]?.total ?? 0,
    lastPaymentAt: pay[0]?.last ? pay[0].last.toISOString() : null,
    draftEstimateCents: drafts[0]?.net ?? 0,
  };
}

export async function customerFinancialSummary(user: CurrentUser, customerId: string) {
  if (!user.permissions.has("financials:read")) throw Errors.forbidden();
  if (!OBJECT_ID_RE.test(customerId)) throw Errors.notFound("Customer");
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  if (!(await Customer.exists({ _id: customerId, organizationId: orgId }))) throw Errors.notFound("Customer");
  return computeCustomerFinancials(orgId, new Types.ObjectId(customerId), user.organization.currency);
}

/**
 * Verifies every invariant for one customer. Used by tests and the
 * /customers/:id/reconcile endpoint. Returns a list of human-readable issues.
 */
export async function reconcileCustomer(organizationId: Types.ObjectId, customerId: Types.ObjectId) {
  const issues: string[] = [];
  const [customer, payments, refunds, bookings, adjustments] = await Promise.all([
    Customer.findOne({ _id: customerId, organizationId }).lean(),
    Payment.find({ organizationId, customerId }).lean(),
    Refund.find({ organizationId, customerId }).lean(),
    Booking.find({ organizationId, customerId }).lean(),
    ChargeAdjustment.find({ organizationId, customerId }).lean(),
  ]);
  if (!customer) return { ok: false, issues: ["customer not found"] };
  const summary = await computeCustomerFinancials(organizationId, customerId, "XXX");

  const refundsByPayment = new Map<string, number>();
  for (const r of refunds) refundsByPayment.set(String(r.paymentId), (refundsByPayment.get(String(r.paymentId)) ?? 0) + r.amountCents);
  const allocatedByLine = new Map<string, number>();
  for (const p of payments) {
    const refunded = refundsByPayment.get(String(p._id)) ?? 0;
    if (refunded !== p.refundedCents) issues.push(`receipt ${p.receiptNumber}: refundedCents ${p.refundedCents} ≠ refunds ${refunded}`);
    const allocRefunded = p.allocations.reduce((s, a) => s + (a.refundedCents ?? 0), 0);
    const net = p.allocations.reduce((s, a) => s + a.amountCents - (a.refundedCents ?? 0), 0);
    if (p.status === "POSTED") {
      if (net !== p.netAllocatedCents) issues.push(`receipt ${p.receiptNumber}: netAllocated ${p.netAllocatedCents} ≠ ${net}`);
      if (p.amountCents - p.refundedCents !== p.netAllocatedCents + p.unallocatedCents) issues.push(`receipt ${p.receiptNumber}: amount − refunded ≠ allocated + unallocated`);
      if (p.unallocatedCents < 0 || p.refundedCents - allocRefunded < 0) issues.push(`receipt ${p.receiptNumber}: negative balance`);
      for (const a of p.allocations) {
        const k = `${a.bookingId}:${a.lineItemId}`;
        allocatedByLine.set(k, (allocatedByLine.get(k) ?? 0) + a.amountCents - (a.refundedCents ?? 0));
      }
    }
  }
  const adjByLine = new Map<string, number>();
  for (const a of adjustments) adjByLine.set(`${a.bookingId}:${a.lineItemId}`, (adjByLine.get(`${a.bookingId}:${a.lineItemId}`) ?? 0) + a.amountCents);
  let outstanding = 0;
  for (const b of bookings) {
    for (const l of b.lineItems) {
      const k = `${b._id}:${l._id}`;
      const alloc = allocatedByLine.get(k) ?? 0;
      const adjc = adjByLine.get(k) ?? 0;
      if ((l.allocatedCents ?? 0) !== alloc) issues.push(`booking ${b.reference} line ${l.name}: allocatedCents ${l.allocatedCents} ≠ receipts ${alloc}`);
      if ((l.adjustmentCents ?? 0) !== adjc) issues.push(`booking ${b.reference} line ${l.name}: adjustmentCents ${l.adjustmentCents} ≠ adjustments ${adjc}`);
      if (b.billingState === "FINALIZED") {
        const bal = (l.chargedCents ?? 0) + adjc - alloc;
        if (bal < 0) issues.push(`booking ${b.reference} line ${l.name}: overpaid by ${-bal}`);
        outstanding += bal;
      } else if (alloc !== 0) issues.push(`booking ${b.reference}: draft line has allocations`);
    }
  }
  if (outstanding !== summary.outstandingCents) issues.push(`line balances ${outstanding} ≠ summary outstanding ${summary.outstandingCents}`);
  if ((customer.outstandingCents ?? 0) !== summary.outstandingCents) issues.push(`customer.outstandingCents ${customer.outstandingCents} ≠ ${summary.outstandingCents}`);
  if ((customer.creditCents ?? 0) !== summary.unallocatedCreditCents) issues.push(`customer.creditCents ${customer.creditCents} ≠ ${summary.unallocatedCreditCents}`);
  if ((customer.pointsBalance ?? 0) !== summary.pointsBalance) issues.push(`customer.pointsBalance ${customer.pointsBalance} ≠ ledger ${summary.pointsBalance}`);
  if (summary.netReceivedCents !== summary.netAllocatedCents + summary.unallocatedCreditCents) issues.push("net received ≠ net allocated + credit");
  return { ok: issues.length === 0, issues, summary };
}

/** Finance tab data: booking charge history and payment/refund history. */
export async function customerFinanceHistory(user: CurrentUser, customerId: string) {
  if (!user.permissions.has("financials:read")) throw Errors.forbidden();
  if (!OBJECT_ID_RE.test(customerId)) throw Errors.notFound("Customer");
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  const cid = new Types.ObjectId(customerId);
  const [bookings, payments, refunds] = await Promise.all([
    Booking.find({ organizationId: orgId, customerId: cid }).select("reference scheduledStartAt status billingState lineItems chargedCents adjustmentsCents allocatedCents netCents taxCents addressSnapshot.city currency").sort({ scheduledStartAt: -1, _id: -1 }).limit(100).lean(),
    Payment.find({ organizationId: orgId, customerId: cid }).sort({ receivedAt: -1, _id: -1 }).limit(100).lean(),
    Refund.find({ organizationId: orgId, customerId: cid }).sort({ refundedAt: -1, _id: -1 }).limit(100).lean(),
  ]);
  const receiptById = new Map(payments.map((p) => [String(p._id), p.receiptNumber]));
  return {
    charges: bookings.map((b) => ({
      bookingId: String(b._id),
      reference: b.reference,
      serviceDate: b.scheduledStartAt.toISOString(),
      status: b.status,
      billingState: b.billingState,
      city: b.addressSnapshot?.city ?? "",
      services: b.lineItems.map((l) => l.name).join(", "),
      netCents: b.netCents ?? 0,
      taxCents: b.taxCents ?? 0,
      chargedCents: b.billingState === "FINALIZED" ? (b.chargedCents ?? 0) + (b.adjustmentsCents ?? 0) : null,
      estimateCents: b.billingState === "DRAFT" ? (b.chargedCents ?? 0) : null,
      paidCents: b.allocatedCents ?? 0,
      balanceCents: b.billingState === "FINALIZED" ? (b.chargedCents ?? 0) + (b.adjustmentsCents ?? 0) - (b.allocatedCents ?? 0) : null,
    })),
    transactions: [
      ...payments.map((p) => ({ kind: "receipt" as const, id: String(p._id), paymentId: String(p._id), receiptNumber: p.receiptNumber, at: p.receivedAt.toISOString(), amountCents: p.amountCents, method: p.method, status: p.status, appliedCents: p.netAllocatedCents, unallocatedCents: p.unallocatedCents, reason: p.status === "REVERSED" ? (p.reversalReason ?? "") : "" })),
      ...refunds.map((r) => ({ kind: "refund" as const, id: String(r._id), paymentId: String(r.paymentId), receiptNumber: receiptById.get(String(r.paymentId)) ?? "", at: r.refundedAt.toISOString(), amountCents: r.amountCents, method: null, status: "POSTED", appliedCents: null, unallocatedCents: null, reason: r.reason })),
    ].sort((a, b) => b.at.localeCompare(a.at)),
  };
}
