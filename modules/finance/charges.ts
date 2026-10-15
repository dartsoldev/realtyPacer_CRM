import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { withTransaction } from "@/lib/db/transaction";
import { Booking } from "@/lib/db/models/booking";
import { ChargeAdjustment } from "@/lib/db/models/charge-adjustment";
import { Organization } from "@/lib/db/models/organization";
import { computeBookingAmounts, NO_TAX, type DiscountInput, type TaxSnapshot } from "@/lib/domain/billing";
import { MAX_MONEY_CENTS } from "@/lib/domain/constants";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { AppError, Errors } from "@/lib/http/errors";
import { recordActivity } from "@/modules/activities/service";
import { recordAudit } from "@/modules/audit/service";
import { applyCustomerDeltas, applyLineDeltas, lineBalance, loadOrgBooking, oid } from "./ledger";

export async function orgTax(organizationId: string | Types.ObjectId): Promise<TaxSnapshot> {
  const org = await Organization.findById(organizationId).select("tax").lean();
  const t = org?.tax;
  return t?.enabled && (t.rateBasisPoints ?? 0) > 0 ? { enabled: true, rateBasisPoints: t.rateBasisPoints ?? 0, label: t.label ?? "Tax" } : NO_TAX;
}

/** $set payload for a DRAFT booking's computed amounts (lines are recomputed, never for FINALIZED). */
export function draftAmountsSet(lines: { lineTotalCents?: number; quantity: number; unitPriceCents: number }[], discount: DiscountInput, tax: TaxSnapshot) {
  const { lines: amounts, totals } = computeBookingAmounts(lines.map((l) => l.lineTotalCents ?? l.quantity * l.unitPriceCents), discount, tax);
  return { amounts, totals };
}

export const discountSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    type: z.enum(["none", "fixed", "percent"]),
    amountCents: z.number().int().min(0).max(MAX_MONEY_CENTS).optional(),
    basisPoints: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine((d) => d.type !== "fixed" || d.amountCents !== undefined, { message: "Enter the discount amount", path: ["amountCents"] })
  .refine((d) => d.type !== "percent" || d.basisPoints !== undefined, { message: "Enter the discount percentage", path: ["basisPoints"] });

function staleError() {
  return new AppError(409, "STALE_VERSION", "Someone else changed this booking since you opened it. Reload and try again.");
}

/** Sets the booking-level discount on a DRAFT booking and recomputes the draft amounts. */
export async function setDiscount(user: CurrentUser, bookingId: string, raw: unknown) {
  if (!user.permissions.has("billing:finalize")) throw Errors.forbidden();
  const input = discountSchema.parse(raw);
  await connectDb();
  const orgId = oid(user.organizationId);
  const tax = await orgTax(orgId);
  await withTransaction(async (session) => {
    const b = await loadOrgBooking(session, orgId, bookingId);
    if (b.version !== input.expectedVersion) throw staleError();
    if (b.billingState === "FINALIZED") throw new AppError(409, "FINALIZED_CHARGES", "Charges are finalized. Use a charge adjustment to correct them.");
    const discount: DiscountInput = { type: input.type, amountCents: input.amountCents ?? 0, basisPoints: input.basisPoints ?? 0 };
    const { amounts, totals } = draftAmountsSet(b.lineItems, discount, tax);
    const set: Record<string, unknown> = { discount, tax, discountCents: totals.discountCents, netCents: totals.netCents, taxCents: totals.taxCents, chargedCents: totals.chargedCents };
    amounts.forEach((a, i) => Object.assign(set, { [`lineItems.${i}.discountCents`]: a.discountCents, [`lineItems.${i}.netCents`]: a.netCents, [`lineItems.${i}.taxCents`]: a.taxCents, [`lineItems.${i}.chargedCents`]: a.chargedCents }));
    const res = await Booking.updateOne({ _id: b._id, version: input.expectedVersion, billingState: "DRAFT" }, { $set: set, $inc: { version: 1 } }, { session });
    if (res.matchedCount === 0) throw staleError();
    await recordActivity({ organizationId: orgId, actorId: user.id, type: "charges.discount_set", customerId: b.customerId, bookingId: b._id, metadata: { type: input.type, amountCents: input.amountCents ?? null, basisPoints: input.basisPoints ?? null } }, session);
  });
  return { ok: true };
}

export const finalizeSchema = z.object({ expectedVersion: z.number().int().min(0) }).strict();

/**
 * DRAFT → FINALIZED. Snapshots the organization's tax configuration, freezes
 * every line's discount/net/tax/charged amounts and creates the amount owed.
 * Allowed for scheduled work (deposits) and completed jobs, not cancelled ones.
 */
export async function finalizeCharges(user: CurrentUser, bookingId: string, raw: unknown) {
  if (!user.permissions.has("billing:finalize")) throw Errors.forbidden();
  const input = finalizeSchema.parse(raw);
  await connectDb();
  const orgId = oid(user.organizationId);
  const tax = await orgTax(orgId);
  await withTransaction(async (session) => {
    const b = await loadOrgBooking(session, orgId, bookingId);
    if (b.version !== input.expectedVersion) throw staleError();
    if (b.billingState === "FINALIZED") throw new AppError(409, "ALREADY_FINALIZED", "These charges are already finalized.");
    if (b.status === "CANCELLED") throw new AppError(409, "BOOKING_CANCELLED", "A cancelled booking can't be finalized.");
    if (b.currency !== user.organization.currency) throw new AppError(409, "CURRENCY_MISMATCH", `This booking is in ${b.currency}; the organization uses ${user.organization.currency}. Mixed currencies aren't supported.`);
    const discount: DiscountInput = { type: (b.discount?.type ?? "none") as DiscountInput["type"], amountCents: b.discount?.amountCents ?? 0, basisPoints: b.discount?.basisPoints ?? 0 };
    const { amounts, totals } = draftAmountsSet(b.lineItems, discount, tax);
    const set: Record<string, unknown> = {
      billingState: "FINALIZED",
      finalizedAt: new Date(),
      finalizedBy: oid(user.id),
      tax,
      discountCents: totals.discountCents,
      netCents: totals.netCents,
      taxCents: totals.taxCents,
      chargedCents: totals.chargedCents,
    };
    amounts.forEach((a, i) => Object.assign(set, { [`lineItems.${i}.discountCents`]: a.discountCents, [`lineItems.${i}.netCents`]: a.netCents, [`lineItems.${i}.taxCents`]: a.taxCents, [`lineItems.${i}.chargedCents`]: a.chargedCents }));
    const res = await Booking.updateOne({ _id: b._id, version: input.expectedVersion, billingState: "DRAFT" }, { $set: set, $inc: { version: 1, ledgerRevision: 1 } }, { session });
    if (res.matchedCount === 0) throw staleError();
    await applyCustomerDeltas(session, orgId, b.customerId, { outstanding: totals.chargedCents });
    await recordActivity({ organizationId: orgId, actorId: user.id, type: "charges.finalized", customerId: b.customerId, bookingId: b._id, metadata: { reference: b.reference, chargedCents: totals.chargedCents, taxBasisPoints: tax.rateBasisPoints } }, session);
    await recordAudit({ organizationId: orgId, actorId: user.id, action: "billing.finalized", entityType: "booking", entityId: b._id, metadata: { reference: b.reference, chargedCents: totals.chargedCents, taxEnabled: tax.enabled, taxBasisPoints: tax.rateBasisPoints } }, session);
  });
  return { ok: true };
}

export const adjustmentSchema = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/),
    lineItemId: z.string().regex(OBJECT_ID_RE),
    /** Negative = credit (reduce owed), positive = extra charge. */
    amountCents: z.number().int().min(-MAX_MONEY_CENTS).max(MAX_MONEY_CENTS).refine((v) => v !== 0, "Enter a non-zero amount"),
    reason: z.string().trim().min(3, "Give a reason").max(1000),
  })
  .strict();

/** Append-only adjustment of one finalized line (credit or extra charge), audited. */
export async function adjustCharge(user: CurrentUser, bookingId: string, raw: unknown) {
  if (!user.permissions.has("billing:adjust")) throw Errors.forbidden();
  const input = adjustmentSchema.parse(raw);
  await connectDb();
  const orgId = oid(user.organizationId);
  if (await ChargeAdjustment.exists({ organizationId: orgId, idempotencyKey: input.idempotencyKey })) return { ok: true, replay: true };
  try {
    await withTransaction(async (session) => {
      const b = await loadOrgBooking(session, orgId, bookingId);
      if (b.billingState !== "FINALIZED") throw new AppError(409, "NOT_FINALIZED", "Only finalized charges can be adjusted. Edit the draft booking instead.");
      const line = b.lineItems.find((l) => String(l._id) === input.lineItemId);
      if (!line) throw Errors.validation("Service line not found on this booking.");
      const outstandingDelta = await applyLineDeltas(session, b, new Map([[input.lineItemId, { adjustment: input.amountCents }]]));
      await applyCustomerDeltas(session, orgId, b.customerId, { outstanding: outstandingDelta });
      await ChargeAdjustment.create(
        [{ organizationId: orgId, customerId: b.customerId, bookingId: b._id, lineItemId: line._id, serviceId: line.serviceId, amountCents: input.amountCents, reason: input.reason, kind: input.amountCents < 0 ? "credit" : "charge", idempotencyKey: input.idempotencyKey, createdBy: oid(user.id) }],
        { session },
      );
      await recordActivity({ organizationId: orgId, actorId: user.id, type: "charges.adjusted", customerId: b.customerId, bookingId: b._id, content: input.reason, metadata: { reference: b.reference, line: line.name, amountCents: input.amountCents } }, session);
      await recordAudit({ organizationId: orgId, actorId: user.id, action: "billing.adjusted", entityType: "booking", entityId: b._id, metadata: { reference: b.reference, amountCents: input.amountCents } }, session);
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return { ok: true, replay: true };
    throw err;
  }
  return { ok: true, replay: false };
}

export const cancellationCreditSchema = z.object({ idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/), reason: z.string().trim().min(3).max(1000) }).strict();

/**
 * Resolves a cancelled, finalized booking: credits every line's unpaid
 * balance so nothing is owed. Money already paid stays allocated until it is
 * refunded (separately, explicitly) — cancellation never refunds by itself.
 */
export async function creditCancelledBooking(user: CurrentUser, bookingId: string, raw: unknown) {
  if (!user.permissions.has("billing:adjust")) throw Errors.forbidden();
  const input = cancellationCreditSchema.parse(raw);
  await connectDb();
  const orgId = oid(user.organizationId);
  if (await ChargeAdjustment.exists({ organizationId: orgId, idempotencyKey: { $regex: `^${input.idempotencyKey}:` } })) return { ok: true, replay: true, creditedCents: 0 };
  let credited = 0;
  await withTransaction(async (session) => {
    credited = 0;
    const b = await loadOrgBooking(session, orgId, bookingId);
    if (b.status !== "CANCELLED") throw new AppError(409, "NOT_CANCELLED", "Only cancelled bookings can be resolved this way.");
    if (b.billingState !== "FINALIZED") throw new AppError(409, "NOT_FINALIZED", "This booking has no finalized charges.");
    const deltas = new Map<string, { adjustment: number }>();
    const docs = [];
    for (const l of b.lineItems) {
      const bal = lineBalance(l);
      if (bal <= 0) continue;
      deltas.set(String(l._id), { adjustment: -bal });
      credited += bal;
      docs.push({ organizationId: orgId, customerId: b.customerId, bookingId: b._id, lineItemId: l._id, serviceId: l.serviceId, amountCents: -bal, reason: input.reason, kind: "cancellation_credit" as const, idempotencyKey: `${input.idempotencyKey}:${String(l._id)}`, createdBy: oid(user.id) });
    }
    if (!docs.length) throw new AppError(409, "NOTHING_OWED", "Nothing is owed on this booking.");
    const outstandingDelta = await applyLineDeltas(session, b, deltas);
    await applyCustomerDeltas(session, orgId, b.customerId, { outstanding: outstandingDelta });
    await ChargeAdjustment.create(docs, { session, ordered: true });
    await recordActivity({ organizationId: orgId, actorId: user.id, type: "charges.adjusted", customerId: b.customerId, bookingId: b._id, content: input.reason, metadata: { reference: b.reference, amountCents: -credited, kind: "cancellation_credit" } }, session);
    await recordAudit({ organizationId: orgId, actorId: user.id, action: "billing.cancellation_credit", entityType: "booking", entityId: b._id, metadata: { reference: b.reference, creditedCents: credited } }, session);
  });
  return { ok: true, replay: false, creditedCents: credited };
}

export async function listAdjustments(user: CurrentUser, bookingId: string) {
  if (!user.permissions.has("financials:read")) throw Errors.forbidden();
  await connectDb();
  if (!OBJECT_ID_RE.test(bookingId)) throw Errors.notFound("Booking");
  const rows = await ChargeAdjustment.find({ organizationId: user.organizationId, bookingId }).sort({ createdAt: 1 }).limit(500).lean();
  return rows.map((r) => ({ id: String(r._id), lineItemId: String(r.lineItemId), amountCents: r.amountCents, reason: r.reason, kind: r.kind, createdAt: r.createdAt.toISOString() }));
}
