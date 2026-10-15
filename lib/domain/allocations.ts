/**
 * Payment allocation rules. Payments are explicitly allocated to booking
 * service line items so "paid for service X in city Y" can be computed exactly.
 *
 * Rules:
 *  1. Every allocation amount is a positive integer number of cents.
 *  2. A payment may not allocate more than its own amount.
 *  3. A payment may not allocate to the same line item twice.
 *  4. Across all *counting* payments, a line item may not receive more than
 *     its line total (checked with `findLineItemOverAllocations`).
 */

export type AllocationInput = { bookingId: string; lineItemId: string; amountCents: number };

export type AllocationIssue =
  | { code: "NON_POSITIVE_AMOUNT"; index: number }
  | { code: "NON_INTEGER_AMOUNT"; index: number }
  | { code: "DUPLICATE_LINE_ITEM"; index: number }
  | { code: "EXCEEDS_PAYMENT_AMOUNT"; allocatedCents: number; paymentCents: number };

export function validatePaymentAllocations(paymentAmountCents: number, allocations: AllocationInput[]): AllocationIssue[] {
  const issues: AllocationIssue[] = [];
  const seen = new Set<string>();
  let total = 0;
  allocations.forEach((a, index) => {
    if (!Number.isSafeInteger(a.amountCents)) issues.push({ code: "NON_INTEGER_AMOUNT", index });
    else if (a.amountCents <= 0) issues.push({ code: "NON_POSITIVE_AMOUNT", index });
    const key = `${a.bookingId}:${a.lineItemId}`;
    if (seen.has(key)) issues.push({ code: "DUPLICATE_LINE_ITEM", index });
    seen.add(key);
    total += a.amountCents;
  });
  if (total > paymentAmountCents) {
    issues.push({ code: "EXCEEDS_PAYMENT_AMOUNT", allocatedCents: total, paymentCents: paymentAmountCents });
  }
  return issues;
}

export type LineItemCapacity = { bookingId: string; lineItemId: string; lineTotalCents: number; alreadyAllocatedCents: number };

export type LineItemOverAllocation = {
  bookingId: string;
  lineItemId: string;
  lineTotalCents: number;
  requestedTotalCents: number;
};

/**
 * Given the capacity of each targeted line item (line total and amounts
 * already allocated by other counting payments), returns the line items the
 * new allocations would push over their line total. Unknown line items are
 * reported with a line total of 0.
 */
export function findLineItemOverAllocations(
  allocations: AllocationInput[],
  capacities: LineItemCapacity[],
): LineItemOverAllocation[] {
  const byKey = new Map(capacities.map((c) => [`${c.bookingId}:${c.lineItemId}`, c]));
  const requested = new Map<string, number>();
  for (const a of allocations) {
    const key = `${a.bookingId}:${a.lineItemId}`;
    requested.set(key, (requested.get(key) ?? 0) + a.amountCents);
  }
  const problems: LineItemOverAllocation[] = [];
  for (const [key, amount] of requested) {
    const cap = byKey.get(key);
    const [bookingId = "", lineItemId = ""] = key.split(":");
    const lineTotal = cap?.lineTotalCents ?? 0;
    const total = (cap?.alreadyAllocatedCents ?? 0) + amount;
    if (!cap || total > lineTotal) {
      problems.push({ bookingId, lineItemId, lineTotalCents: lineTotal, requestedTotalCents: total });
    }
  }
  return problems;
}

/** Payment statuses whose allocations count toward "paid" totals. */
export const COUNTING_PAYMENT_STATUSES = ["pending", "completed"] as const;
