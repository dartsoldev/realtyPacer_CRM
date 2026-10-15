/**
 * Billing arithmetic. Integer minor units (cents) only; intermediate products
 * use BigInt so large amounts can't lose precision. Client- and server-safe.
 *
 * Definitions (see PROJECT_STATE.md → "Financial definitions"):
 *  - gross   = quantity × unit price
 *  - discount= booking-level discount allocated to this line
 *  - net     = gross − discount (before tax)
 *  - tax     = round_half_up(net × rate) per line, only when tax is configured
 *  - charged = net + tax   (frozen at finalization)
 *  - balance = charged + adjustments − net allocated paid  (never negative)
 */

export type DiscountInput = { type: "none" | "fixed" | "percent"; amountCents?: number; basisPoints?: number };
export type TaxSnapshot = { enabled: boolean; rateBasisPoints: number; label: string };

export const NO_TAX: TaxSnapshot = { enabled: false, rateBasisPoints: 0, label: "" };

/** round(numer / denom) with halves rounded up, for non-negative integers. */
export function divRoundHalfUp(numer: bigint, denom: bigint): bigint {
  if (numer < 0n || denom <= 0n) throw new RangeError("divRoundHalfUp expects non-negative values");
  return (numer * 2n + denom) / (denom * 2n);
}

/** Booking-level discount in cents, capped at the gross total. Percent is in basis points (10000 = 100%). */
export function bookingDiscountCents(grossTotal: number, d: DiscountInput): number {
  if (d.type === "fixed") return Math.min(Math.max(0, d.amountCents ?? 0), grossTotal);
  if (d.type === "percent") {
    const bp = Math.min(Math.max(0, d.basisPoints ?? 0), 10_000);
    return Number(divRoundHalfUp(BigInt(grossTotal) * BigInt(bp), 10_000n));
  }
  return 0;
}

/**
 * Splits `total` across lines in proportion to `weights` (largest-remainder
 * method). Each line first gets floor(total × w / Σw); the leftover cents go
 * one at a time to the lines with the largest fractional remainder, ties to
 * the earlier line. Deterministic, and the parts always sum to `total`.
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const T = BigInt(total);
  const S = BigInt(sum);
  const base = weights.map((w) => (T * BigInt(w)) / S);
  const rema = weights.map((w, i) => ({ i, r: (T * BigInt(w)) % S }));
  let left = total - base.reduce((a, b) => a + Number(b), 0);
  rema.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = base.map(Number);
  for (const { i } of rema) {
    if (left <= 0) break;
    if (weights[i] === 0) continue;
    out[i]! += 1;
    left -= 1;
  }
  return out;
}

export type LineAmounts = { grossCents: number; discountCents: number; netCents: number; taxCents: number; chargedCents: number };

/** Computes every line's discount, net, tax and charged amount, plus booking totals. */
export function computeBookingAmounts(grossPerLine: number[], discount: DiscountInput, tax: TaxSnapshot) {
  const gross = grossPerLine.reduce((a, b) => a + b, 0);
  const discountTotal = bookingDiscountCents(gross, discount);
  const discounts = allocateProportionally(discountTotal, grossPerLine);
  const lines: LineAmounts[] = grossPerLine.map((g, i) => {
    const net = g - discounts[i]!;
    const taxCents = tax.enabled && tax.rateBasisPoints > 0 ? Number(divRoundHalfUp(BigInt(net) * BigInt(tax.rateBasisPoints), 10_000n)) : 0;
    return { grossCents: g, discountCents: discounts[i]!, netCents: net, taxCents, chargedCents: net + taxCents };
  });
  const totals = lines.reduce(
    (t, l) => ({ grossCents: t.grossCents + l.grossCents, discountCents: t.discountCents + l.discountCents, netCents: t.netCents + l.netCents, taxCents: t.taxCents + l.taxCents, chargedCents: t.chargedCents + l.chargedCents }),
    { grossCents: 0, discountCents: 0, netCents: 0, taxCents: 0, chargedCents: 0 },
  );
  return { lines, totals };
}

export type OpenLine = { bookingId: string; lineItemId: string; balanceCents: number };

/**
 * Default allocation for a new receipt: pay the given open lines in order
 * (callers pass them oldest service date first) until the amount runs out.
 * Anything left becomes unallocated customer credit.
 */
export function defaultAllocation(amountCents: number, open: OpenLine[]) {
  let left = amountCents;
  const allocations: { bookingId: string; lineItemId: string; amountCents: number }[] = [];
  for (const l of open) {
    if (left <= 0) break;
    const take = Math.min(left, l.balanceCents);
    if (take > 0) {
      allocations.push({ bookingId: l.bookingId, lineItemId: l.lineItemId, amountCents: take });
      left -= take;
    }
  }
  return { allocations, unallocatedCents: left };
}

/** Basis points from a percentage string like "12.5" → 1250; null if invalid. */
export function percentToBasisPoints(input: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= 10_000 ? bp : null;
}

export function formatBasisPoints(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac ? `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%` : `${whole}%`;
}
