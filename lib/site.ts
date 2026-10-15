/**
 * Public site origin for metadata/sitemaps. Falls back to the production
 * domain so builds without APP_URL still emit correct canonical URLs.
 */
export function siteUrl(): string {
  const raw = process.env.APP_URL;
  try {
    if (raw) return new URL(raw).origin;
  } catch {
    /* fall through */
  }
  return "https://realtypacer.com";
}

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeCallbackPath(input: string | null | undefined, fallback = "/dashboard"): string {
  if (!input || typeof input !== "string") return fallback;
  if (!input.startsWith("/") || input.startsWith("//") || input.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f]/.test(input)) return fallback;
  try {
    const url = new URL(input, "http://local.invalid");
    if (url.origin !== "http://local.invalid") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
