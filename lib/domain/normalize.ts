/** Pure normalisation helpers shared by validation and persistence. */

export function normalizeEmail(email: string): string {
  return email.normalize("NFKC").trim().toLowerCase();
}

/**
 * Normalises a phone number to an E.164-like string. North American 10-digit
 * numbers get a +1 prefix. Returns null when the input has too few digits.
 */
export function normalizePhone(input: string, defaultCountryCode = "1"): string | null {
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  if (hasPlus) return `+${digits}`;
  if (defaultCountryCode === "1" && digits.length === 10) return `+1${digits}`;
  if (defaultCountryCode === "1" && digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${defaultCountryCode}${digits}`;
}

/** Lower-cased, whitespace-collapsed city key used for exact-match filtering. */
export function normalizeCity(city: string): string {
  return city.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Escapes user text for safe use inside a RegExp (prevents ReDoS/injection). */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
