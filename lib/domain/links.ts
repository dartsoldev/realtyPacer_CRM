/** External links and map URLs. Client- and server-safe. */

export function isSafeHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && Boolean(u.hostname);
  } catch {
    return false;
  }
}

export type MappableAddress = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  location?: { lat: number; lng: number } | null;
};

/**
 * Google Maps search URL (no API key needed). Prefers valid coordinates,
 * otherwise the encoded full address.
 */
export function googleMapsUrl(a: MappableAddress): string | null {
  const loc = a.location;
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) && Math.abs(loc.lat) <= 90 && Math.abs(loc.lng) <= 180) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${loc.lat},${loc.lng}`)}`;
  }
  const text = formatAddress(a);
  if (!text) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`;
}

export function formatAddress(a: MappableAddress): string {
  const cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(" ").trim();
  return [a.line1, a.line2, cityLine, a.country].map((s) => (s ?? "").trim()).filter(Boolean).join(", ");
}

/** `tel:` href from an E.164 number (no spaces or formatting). */
export function telHref(e164: string): string {
  return `tel:${e164.replace(/[^+\d]/g, "")}`;
}
