import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/min";

export const DEFAULT_PHONE_COUNTRY: CountryCode = "CA";

export type ParsedPhone = { e164: string; display: string; country: string | null; digits: string };

/**
 * Parses a phone number. Numbers without "+" are interpreted for
 * `defaultCountry` (Canada by default); international numbers keep their own
 * country code. Returns null when the number is not plausible.
 */
export function parsePhone(input: string, defaultCountry: string = DEFAULT_PHONE_COUNTRY): ParsedPhone | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 40) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry as CountryCode);
  if (!parsed || !parsed.isPossible()) return null;
  const sameCountry = parsed.country === defaultCountry || (!parsed.country && parsed.countryCallingCode === "1" && defaultCountry === "CA");
  return {
    e164: parsed.number,
    display: sameCountry ? parsed.formatNational() : parsed.formatInternational(),
    country: parsed.country ?? null,
    digits: parsed.number.replace(/\D/g, ""),
  };
}

/** Digits-only search key ("(514) 555-01" → "51455501"). */
export function phoneSearchDigits(query: string): string {
  return query.replace(/\D/g, "");
}

export { telHref } from "./links";
