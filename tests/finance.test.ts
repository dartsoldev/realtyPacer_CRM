import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { Booking } from "@/lib/db/models/booking";
import { Customer } from "@/lib/db/models/customer";
import { Organization } from "@/lib/db/models/organization";
import { Payment } from "@/lib/db/models/payment";
import { allocateProportionally, computeBookingAmounts, defaultAllocation } from "@/lib/domain/billing";
import { transitionBooking, updateBooking } from "@/modules/bookings/service";
import { adjustCharge, creditCancelledBooking, finalizeCharges, setDiscount } from "@/modules/finance/charges";
import { allocateCredit, openCharges, recordPayment, recordRefund, reversePayment } from "@/modules/finance/payments";
import { reconcileCustomer } from "@/modules/finance/summary";
import { addLoyaltyEntry } from "@/modules/loyalty/service";
import { runReport } from "@/modules/reports/engine";
import { createUser, createOrg } from "./helpers/fixtures";
import { actorFor, opsWorld } from "./helpers/ops-fixtures";
import { customerIn, finalizedBooking, key, pay } from "./helpers/finance-fixtures";

vi.mock("@/lib/auth/claims", () => ({ getSessionClaims: vi.fn() }));

const rec = async (orgId: Types.ObjectId, customerId: string) => {
  const r = await reconcileCustomer(orgId, new Types.ObjectId(customerId));
  expect(r.issues).toEqual([]);
  return r.summary!;
};

describe("billing arithmetic (integer cents, deterministic)", () => {
  it("allocates booking discounts proportionally with a deterministic remainder", () => {
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]); // tie → earlier line
    expect(allocateProportionally(600, [1000, 2000, 3001])).toEqual([100, 200, 300]);
    const parts = allocateProportionally(1001, [333, 333, 334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
  });

  it("computes percent discounts and per-line tax with half-up rounding", () => {
    const { lines, totals } = computeBookingAmounts([1000, 2000, 3001], { type: "percent", basisPoints: 1000 }, { enabled: true, rateBasisPoints: 1300, label: "HST" });
    expect(totals.discountCents).toBe(600); // round(600.1)
    expect(lines.map((l) => l.netCents)).toEqual([900, 1800, 2701]);
    expect(lines.map((l) => l.taxCents)).toEqual([117, 234, 351]); // 351.13 → 351
    expect(totals.chargedCents).toBe(5401 + 702);
    expect(computeBookingAmounts([500], { type: "fixed", amountCents: 9999 }, { enabled: false, rateBasisPoints: 0, label: "" }).totals.netCents).toBe(0); // capped
  });

  it("suggests an oldest-first default allocation with the rest as credit", () => {
    expect(defaultAllocation(250, [{ bookingId: "a", lineItemId: "1", balanceCents: 100 }, { bookingId: "b", lineItemId: "2", balanceCents: 100 }])).toEqual({
      allocations: [{ bookingId: "a", lineItemId: "1", amountCents: 100 }, { bookingId: "b", lineItemId: "2", amountCents: 100 }],
      unallocatedCents: 50,
    });
  });
});

describe("required reporting example: Mississauga AND Sofa cleaning", () => {
  it("counts only matching lines, customers and allocations; excludes carpet and Toronto", async () => {
    const { admin, sofa, carpet, ana, ben, org } = await opsWorld();
    const S = String(sofa._id);
    const C = String(carpet._id);
    const a = await customerIn(admin, "Mississauga", "Alice");
    const b = await customerIn(admin, "Mississauga", "Bob");
    const t = await customerIn(admin, "Toronto", "Tia");
    const bookA = await finalizedBooking(admin, a, [{ serviceId: S, unitPriceCents: 15000 }, { serviceId: C, unitPriceCents: 10000 }], { date: "2026-06-10" });
    const bookB = await finalizedBooking(admin, b, [{ serviceId: S, unitPriceCents: 20000 }], { date: "2026-06-20", cleanerIds: [String(ana._id), String(ben._id)] });
    await finalizedBooking(admin, t, [{ serviceId: S, unitPriceCents: 30000 }], { date: "2026-06-15" });
    await pay(admin, a.customer.id, 12500, [
      { bookingId: bookA.id, lineItemId: bookA.lineFor(S), amountCents: 7500 },
      { bookingId: bookA.id, lineItemId: bookA.lineFor(C), amountCents: 5000 },
    ]);
    const payB = await pay(admin, b.customer.id, 20000, [{ bookingId: bookB.id, lineItemId: bookB.lineFor(S), amountCents: 20000 }]);

    const def = (extra: { field: string; op: string; value?: unknown }[] = []) => ({
      mode: "service" as const,
      datePreset: "custom" as const,
      from: "2026-06-01",
      to: "2026-06-30",
      statuses: ["COMPLETED" as const],
      filters: { logic: "and" as const, conditions: [{ field: "city", op: "any_of" as const, value: ["Mississauga"] }, { field: "service", op: "eq" as const, value: S }, ...(extra as never[])] },
    });
    const r = await runReport(admin, def());
    expect(r.totals).toMatchObject({ uniqueCustomers: 2, distinctBookings: 2, serviceLines: 2, chargedCents: 35000, paidCents: 27500, outstandingCents: 7500 });
    expect(r.rows.map((x) => x.service)).toEqual(["Sofa cleaning", "Sofa cleaning"]);
    expect(r.breakdowns.find((x) => x.key === "service")!.rows.map((x) => x.label)).toEqual(["Sofa cleaning"]);

    // Totals cover the whole result, not the page.
    const paged = await runReport(admin, def(), { page: 2, pageSize: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.totals.chargedCents).toBe(35000);

    // Multi-cleaner booking counted once, amounts not duplicated.
    const both = await runReport(admin, def([{ field: "cleaner", op: "any_of", value: [String(ana._id), String(ben._id)] }]));
    expect(both.totals).toMatchObject({ distinctBookings: 1, serviceLines: 1, chargedCents: 20000, paidCents: 20000 });
    expect(both.breakdowns.find((x) => x.key === "cleaner")!.rows.map((x) => x.values.bookings)).toEqual([1, 1]);

    // Customer summary: one row per customer.
    const cs = await runReport(admin, { ...def(), mode: "customers" });
    expect(cs.rows).toHaveLength(2);
    expect(cs.totals).toMatchObject({ uniqueCustomers: 2, chargedCents: 35000, paidCents: 27500, outstandingCents: 7500 });

    // Refund in a later period: paid drops, cash report counts it in its own period.
    await recordRefund(admin, payB.id, { idempotencyKey: key(), amountCents: 2500, refundedDate: "2026-07-05", refundedTime: "09:00", reason: "Partial refund for stain" });
    const after = await runReport(admin, def());
    expect(after.totals).toMatchObject({ chargedCents: 35000, paidCents: 25000, outstandingCents: 10000 });
    const june = await runReport(admin, { ...def(), mode: "cash", filters: { logic: "and", conditions: [] } });
    expect(june.totals).toMatchObject({ receiptsCents: 32500, refundsCents: 0, netCashCents: 32500 });
    const july = await runReport(admin, { ...def(), mode: "cash", from: "2026-07-01", to: "2026-07-31", filters: { logic: "and", conditions: [{ field: "city", op: "eq", value: "Mississauga" }, { field: "service", op: "eq", value: S }] } });
    expect(july.totals).toMatchObject({ receiptsCents: 0, refundsCents: 2500, netCashCents: -2500 });

    for (const c of [a, b, t]) await rec(org._id, c.customer.id);
  });

  it("uses org-timezone date boundaries (start inclusive, end exclusive)", async () => {
    const { admin, sofa } = await opsWorld();
    const S = String(sofa._id);
    const c = await customerIn(admin, "Mississauga", "Late");
    await finalizedBooking(admin, c, [{ serviceId: S, unitPriceCents: 1000 }], { date: "2026-06-30", time: "23:30" }); // 03:30 UTC Jul 1
    await finalizedBooking(admin, c, [{ serviceId: S, unitPriceCents: 2000 }], { date: "2026-07-01", time: "00:00" });
    const r = await runReport(admin, { mode: "service", datePreset: "custom", from: "2026-06-01", to: "2026-06-30", statuses: ["COMPLETED"], filters: { logic: "and", conditions: [] } });
    expect(r.totals.chargedCents).toBe(1000);
  });
});

describe("payments, credit, refunds and corrections", () => {
  it("handles partial, multiple and full payments, and one payment across bookings", async () => {
    const { admin, sofa, org } = await opsWorld();
    const S = String(sofa._id);
    const c = await customerIn(admin, "Mississauga", "Pat");
    const b1 = await finalizedBooking(admin, c, [{ serviceId: S, unitPriceCents: 10000 }]);
    const b2 = await finalizedBooking(admin, c, [{ serviceId: S, unitPriceCents: 5000 }], { date: "2026-06-12" });
    await pay(admin, c.customer.id, 4000, [{ bookingId: b1.id, lineItemId: b1.lineFor(S), amountCents: 4000 }]);
    let s = await rec(org._id, c.customer.id);
    expect(s.outstandingCents).toBe(11000);
    await pay(admin, c.customer.id, 9000, [
      { bookingId: b1.id, lineItemId: b1.lineFor(S), amountCents: 6000 },
      { bookingId: b2.id, lineItemId: b2.lineFor(S), amountCents: 3000 },
    ]);
    s = await rec(org._id, c.customer.id);
    expect(s).toMatchObject({ outstandingCents: 2000, netReceivedCents: 13000, unallocatedCreditCents: 0 });
    await expect(pay(admin, c.customer.id, 3000, [{ bookingId: b2.id, lineItemId: b2.lineFor(S), amountCents: 3000 }])).rejects.toMatchObject({ code: "LINE_OVERPAID" });
    await pay(admin, c.customer.id, 2000, [{ bookingId: b2.id, lineItemId: b2.lineFor(S), amountCents: 2000 }]);
    expect((await rec(org._id, c.customer.id)).outstandingCents).toBe(0);
    expect(await openCharges(admin, c.customer.id)).toEqual([]);
  });

  it("keeps unallocated money as credit and applies it later", async () => {
    const { admin, sofa, org } = await opsWorld();
    const S = String(sofa._id);
    const c = await customerIn(admin, "Toronto", "Credit");
    const p = await pay(admin, c.customer.id, 8000);
    expect((await rec(org._id, c.customer.id)).unallocatedCreditCents).toBe(8000);
    const b = await finalizedBooking(admin, c, [{ serviceId: S, unitPriceCents: 5000 }]);
    const receipt = (await Payment.findById(p.id).lean())!;
    await expect(allocateCredit(admin, p.id, { expectedRevision: receipt.revision, allocations: [{ bookingId: b.id, lineItemId: b.lineFor(S), amountCents: 9000 }] })).rejects.toMatchObject({ code: "INSUFFICIENT_CREDIT" });
    await allocateCredit(admin, p.id, { expectedRevision: receipt.revision, allocations: [{ bookingId: b.id, lineItemId: b.lineFor(S), amountCents: 5000 }] });
    const s = await rec(org._id, c.customer.id);
    expect(s).toMatchObject({ outstandingCents: 0, unallocatedCreditCents: 3000, netAllocatedCents: 5000 });
    expect((await Customer.findById(c.customer.id).lean())!.creditCents).toBe(3000);
    // A stale second click is rejected (no double application).
    await expect(allocateCredit(admin, p.id, { expectedRevision: receipt.revision, allocations: [{ bookingId: b.id, lineItemId: b.lineFor(S), amountCents: 1 }] })).rejects.toMatchObject({ code: "STALE_VERSION" });
  });

  it("rejects cross-customer, cross-organization and draft allocations", async () => {
    const { admin, sofa } = await opsWorld();
    const S = String(sofa._id);
    const a = await customerIn(admin, "Toronto", "Ann");
    const b = await customerIn(admin, "Toronto", "Ben");
    const bookB = await finalizedBooking(admin, b, [{ serviceId: S, unitPriceCents: 5000 }]);
    await expect(pay(admin, a.customer.id, 5000, [{ bookingId: bookB.id, lineItemId: bookB.lineFor(S), amountCents: 5000 }])).rejects.toMatchObject({ code: "OTHER_CUSTOMER" });
    const draft = await finalizedBooking(admin, a, [{ serviceId: S, unitPriceCents: 5000 }], { finalize: false });
    await expect(pay(admin, a.customer.id, 5000, [{ bookingId: draft.id, lineItemId: draft.lineFor(S), amountCents: 5000 }])).rejects.toMatchObject({ code: "NOT_FINALIZED" });
    const other = await createOrg("Other Org");
    const outsider = await actorFor(await createUser(other._id, { role: "ADMIN" }));
    await expect(pay(outsider, a.customer.id, 100)).rejects.toMatchObject({ status: 404 });
    await expect(recordPayment(admin, { idempotencyKey: key(), customerId: a.customer.id, amountCents: 100, currency: "USD", receivedDate: "2026-06-11", receivedTime: "12:00", method: "cash" })).rejects.toMatchObject({ code: "CURRENCY_MISMATCH" });
    expect(await Payment.countDocuments({ customerId: a.customer.id })).toBe(0);
  });

  it("is idempotent under duplicate submission and safe under concurrent allocation", async () => {
    const { admin, sofa, org } = await opsWorld();
    const S = String(sofa._id);
    const c = await customerIn(admin, "Toronto", "Dup");
    const b = await finalizedBooking(admin, c, [{ serviceId: S, unitPriceCents: 10000 }]);
    const body = { idempotencyKey: key(), customerId: c.customer.id, amountCents: 3000, receivedDate: "2026-06-11", receivedTime: "12:00", method: "cash", allocations: [{ bookingId: b.id, lineItemId: b.lineFor(S), amountCents: 3000 }] };
    const results = await Promise.all([recordPayment(admin, body), recordPayment(admin, body), recordPayment(admin, body)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await Payment.countDocuments({ customerId: c.customer.id })).toBe(1);
    // Two different payments racing for the remaining 7000 of one line: only one fits.
    const race = await Promise.allSettled([0, 1].map(() => pay(admin, c.customer.id, 7000, [{ bookingId: b.id, lineItemId: b.lineFor(S), amountCents: 7000 }])));
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of race.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) expect(["LINE_OVERPAID", "BUSY_RETRY"]).toContain((r.reason as { code: string }).code);
    expect((await rec(org._id, c.customer.id)).outstandingCents).toBe(0);
  });

  it("records refunds against allocations or credit, never above the receipt, and reconciles", async () => {
    const { admin, sofa, org } = await opsWorld();
    const S = String(sofa._id);
    const c = await customerIn(admin, "Toronto", "Ref");
    const b = await finalizedBooking(admin, c, [{ serviceId: S, unitPriceCents: 6000 }]);
    const p = await pay(admin, c.customer.id, 10000, [{ bookingId: b.id, lineItemId: b.lineFor(S), amountCents: 6000 }]);
    // Default order: unallocated first (4000), then the allocation.
    await recordRefund(admin, p.id, { idempotencyKey: key(), amountCents: 5000, refundedDate: "2026-06-15", refundedTime: "10:00", reason: "Customer overpaid" });
    let s = await rec(org._id, c.customer.id);
    expect(s).toMatchObject({ grossReceiptsCents: 10000, refundsCents: 5000, netReceivedCents: 5000, unallocatedCreditCents: 0, netAllocatedCents: 5000, outstandingCents: 1000 });
    await expect(recordRefund(admin, p.id, { idempotencyKey: key(), amountCents: 5001, refundedDate: "2026-06-15", refundedTime: "10:00", reason: "Too much" })).rejects.toMatchObject({ code: "REFUND_EXCEEDS_RECEIPT" });
    await expect(recordRefund(admin, p.id, { idempotencyKey: key(), amountCents: 100, refundedDate: "2026-06-10", refundedTime: "10:00", reason: "Before receipt" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // Receipts with refunds can't be reversed (append-only correction instead).
    const receipt = (await Payment.findById(p.id).lean())!;
    await expect(reversePayment(admin, p.id, { expectedRevision: receipt.revision, reason: "Mistake" })).rejects.toMatchObject({ code: "HAS_REFUNDS" });
    s = await rec(org._id, c.customer.id);
    expect(s.netReceivedCents).toBe(s.netAllocatedCents + s.unallocatedCreditCents);
  });

  it("reverses a mistaken receipt without deleting it", async () => {
    const { admin, sofa, org } = await opsWorld();
    const S = String(sofa._id);
    const c = await customerIn(admin, "Toronto", "Rev");
    const b = await finalizedBooking(admin, c, [{ serviceId: S, unitPriceCents: 6000 }]);
    const p = await pay(admin, c.customer.id, 7000, [{ bookingId: b.id, lineItemId: b.lineFor(S), amountCents: 6000 }]);
    await reversePayment(admin, p.id, { expectedRevision: 0, reason: "Entered on the wrong customer" });
    const s = await rec(org._id, c.customer.id);
    expect(s).toMatchObject({ grossReceiptsCents: 0, outstandingCents: 6000, unallocatedCreditCents: 0 });
    expect((await Payment.findById(p.id).lean())!.status).toBe("REVERSED");
  });

  it("distinguishes charge credits from refunds, and resolves cancelled bookings explicitly", async () => {
    const { admin, sofa, org } = await opsWorld();
    const S = String(sofa._id);
    const c = await customerIn(admin, "Toronto", "Adj");
    const b = await finalizedBooking(admin, c, [{ serviceId: S, unitPriceCents: 10000 }]);
    await pay(admin, c.customer.id, 3000, [{ bookingId: b.id, lineItemId: b.lineFor(S), amountCents: 3000 }]);
    // Credit reduces what's owed; money received is unchanged.
    await adjustCharge(admin, b.id, { idempotencyKey: key(), lineItemId: b.lineFor(S), amountCents: -2000, reason: "Goodwill" });
    let s = await rec(org._id, c.customer.id);
    expect(s).toMatchObject({ chargesAfterAdjustmentsCents: 8000, netReceivedCents: 3000, outstandingCents: 5000 });
    // A credit can't push the charge below what's already paid.
    await expect(adjustCharge(admin, b.id, { idempotencyKey: key(), lineItemId: b.lineFor(S), amountCents: -6000, reason: "Too much" })).rejects.toMatchObject({ code: "CREDIT_BELOW_PAID" });
    // Finalized lines can't be edited directly.
    const fresh = (await Booking.findById(b.id).lean())!;
    await expect(updateBooking(admin, b.id, { expectedVersion: fresh.version, lineItems: [{ serviceId: S, quantity: 2 }] })).rejects.toMatchObject({ code: "NOT_EDITABLE" });

    // Cancelled + finalized booking: explicit credit of the unpaid balance; payments stay.
    const sched = await (await import("@/modules/bookings/service")).createBooking(admin, { idempotencyKey: key(), customerId: c.customer.id, addressId: c.address.id, date: "2030-02-01", startTime: "10:00", durationMinutes: 60, lineItems: [{ serviceId: S, quantity: 1, unitPriceCents: 5000 }] });
    await finalizeCharges(admin, sched.booking.id, { expectedVersion: sched.booking.version });
    const schedDoc = (await Booking.findById(sched.booking.id).lean())!;
    await pay(admin, c.customer.id, 1000, [{ bookingId: sched.booking.id, lineItemId: String(schedDoc.lineItems[0]!._id), amountCents: 1000 }]); // deposit
    await transitionBooking(admin, sched.booking.id, { action: "cancel", reason: "Customer moved", expectedVersion: schedDoc.version });
    const credit = await creditCancelledBooking(admin, sched.booking.id, { idempotencyKey: key(), reason: "Cancelled job" });
    expect(credit.creditedCents).toBe(4000);
    s = await rec(org._id, c.customer.id);
    expect(s.netReceivedCents).toBe(4000); // deposit not refunded automatically
  });

  it("finalizes with a tax snapshot and discount; later tax changes don't rewrite it", async () => {
    const { admin, sofa, carpet, org } = await opsWorld();
    const c = await customerIn(admin, "Toronto", "Tax");
    await Organization.updateOne({ _id: org._id }, { $set: { tax: { enabled: true, rateBasisPoints: 1300, label: "HST" } } });
    const draft = await finalizedBooking(admin, c, [{ serviceId: String(sofa._id), unitPriceCents: 1000 }, { serviceId: String(carpet._id), unitPriceCents: 2001 }], { finalize: false });
    await setDiscount(admin, draft.id, { expectedVersion: draft.doc.version, type: "percent", basisPoints: 1000 });
    const d = (await Booking.findById(draft.id).lean())!;
    await finalizeCharges(admin, draft.id, { expectedVersion: d.version });
    await Organization.updateOne({ _id: org._id }, { $set: { tax: { enabled: true, rateBasisPoints: 500, label: "GST" } } });
    const f = (await Booking.findById(draft.id).lean())!;
    expect(f.tax).toMatchObject({ rateBasisPoints: 1300, label: "HST" });
    expect(f.lineItems.map((l) => [l.discountCents, l.netCents, l.taxCents, l.chargedCents])).toEqual([
      [100, 900, 117, 1017],
      [200, 1801, 234, 2035],
    ]);
    expect((await rec(org._id, c.customer.id)).outstandingCents).toBe(3052);
    await expect(setDiscount(admin, draft.id, { expectedVersion: f.version, type: "none" })).rejects.toMatchObject({ code: "FINALIZED_CHARGES" });
  });
});

describe("loyalty points", () => {
  it("keeps an append-only ledger, prevents negative balances and reverses once", async () => {
    const { admin, org } = await opsWorld();
    const c = await customerIn(admin, "Toronto", "Pts");
    const g = await addLoyaltyEntry(admin, c.customer.id, { type: "grant", idempotencyKey: key(), points: 100, reason: "Welcome bonus" });
    expect(g.balance).toBe(100);
    const gKey = key();
    const second = await addLoyaltyEntry(admin, c.customer.id, { type: "grant", idempotencyKey: gKey, points: 5, reason: "Review bonus" });
    expect(second.balance).toBe(105);
    // Same key again: no duplicate entry.
    expect((await addLoyaltyEntry(admin, c.customer.id, { type: "grant", idempotencyKey: gKey, points: 5, reason: "Review bonus" })).created).toBe(false);
    await expect(addLoyaltyEntry(admin, c.customer.id, { type: "redeem", idempotencyKey: key(), points: 1000, reason: "Too many" })).rejects.toMatchObject({ code: "INSUFFICIENT_POINTS" });
    const race = await Promise.allSettled([0, 1, 2].map(() => addLoyaltyEntry(admin, c.customer.id, { type: "redeem", idempotencyKey: key(), points: 60, reason: "Free sofa" })));
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await Customer.findById(c.customer.id).lean())!.pointsBalance).toBe(45);
    await addLoyaltyEntry(admin, c.customer.id, { type: "reversal", idempotencyKey: key(), entryId: g.id, reason: "Granted by mistake" }).catch((e) => expect(e.code).toBe("INSUFFICIENT_POINTS"));
    await addLoyaltyEntry(admin, c.customer.id, { type: "correction", idempotencyKey: key(), pointsChange: 55, reason: "Restore" });
    await addLoyaltyEntry(admin, c.customer.id, { type: "reversal", idempotencyKey: key(), entryId: g.id, reason: "Granted by mistake" });
    await expect(addLoyaltyEntry(admin, c.customer.id, { type: "reversal", idempotencyKey: key(), entryId: g.id, reason: "Again" })).rejects.toMatchObject({ code: "ALREADY_REVERSED" });
    expect((await rec(org._id, c.customer.id)).pointsBalance).toBe(0);
  });
});
