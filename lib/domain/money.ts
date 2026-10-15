/** Money is always stored as integer minor units (cents). */

export function assertCents(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be an integer number of cents`);
  return value;
}

export function formatCents(cents: number, currency: string, locale = "en-CA"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

/** Parses a user-entered decimal amount ("12.5", "1,234.00") to integer cents. */
export function parseAmountToCents(input: string): number | null {
  const cleaned = input.replace(/[,\s$]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return cleaned.startsWith("-") ? -cents : cents;
}
