import "server-only";
import { getCoreEnv } from "@/lib/env";
import { Errors } from "./errors";

type HeaderSource = Headers | Record<string, string | string[] | undefined> | undefined;

function header(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Client IP for rate limiting. Forwarded headers are spoofable unless a
 * trusted proxy overwrites them, so they are only used when
 * TRUST_PROXY_HEADERS=true. Returns null when unknown.
 */
export function clientIp(headers: HeaderSource): string | null {
  if (!getCoreEnv().TRUST_PROXY_HEADERS) return null;
  const xff = header(headers, "x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || header(headers, "x-real-ip")?.trim() || null;
}

/**
 * CSRF defence for custom state-changing endpoints: the browser-supplied
 * Origin (or Sec-Fetch-Site) must match the trusted APP_URL origin, and the
 * body must be JSON (HTML forms cannot send application/json cross-site
 * without a CORS preflight, which we never allow).
 */
export function assertSameOrigin(req: Request) {
  const appOrigin = getCoreEnv().APP_URL;
  const origin = req.headers.get("origin");
  if (origin) {
    if (origin !== appOrigin) throw Errors.badOrigin();
  } else {
    const site = req.headers.get("sec-fetch-site");
    if (site !== "same-origin") throw Errors.badOrigin();
  }
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE") {
    const type = req.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/json")) {
      throw Errors.validation("Requests must use Content-Type: application/json.");
    }
  }
}

const MAX_BODY_BYTES = 32 * 1024;

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw Errors.validation("Request body is too large.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Errors.validation("Request body must be valid JSON.");
  }
}
