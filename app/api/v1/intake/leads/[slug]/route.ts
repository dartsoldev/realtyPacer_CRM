import { clientIp } from "@/lib/http/request";
import { logger } from "@/lib/logger";
import { receiveSubmission } from "@/modules/leads/intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 32 * 1024;
const HEADERS = { "Cache-Control": "no-store", "Content-Type": "application/json" };

function json(status: number, body: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

/**
 * Server-to-server lead intake for website forms.
 *   POST /api/v1/intake/leads/{sourceId}
 *   Authorization: Bearer <source key>
 *   Content-Type: application/json | application/x-www-form-urlencoded
 *   Idempotency-Key: <optional submission id>
 * Not for browser JavaScript: the key must stay on the website's server.
 * 201 = created, 200 = duplicate (already received), 401, 422, 429.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return json(413, { error: { code: "TOO_LARGE", message: "Body is too large." } });
    const text = await req.text();
    if (text.length > MAX_BYTES) return json(413, { error: { code: "TOO_LARGE", message: "Body is too large." } });
    const type = (req.headers.get("content-type") ?? "").toLowerCase();
    let payload: unknown;
    if (type.startsWith("application/json")) {
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        return json(400, { error: { code: "INVALID_JSON", message: "Body must be valid JSON." } });
      }
    } else if (type.startsWith("application/x-www-form-urlencoded")) {
      payload = Object.fromEntries(new URLSearchParams(text));
    } else {
      return json(415, { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Use application/json or application/x-www-form-urlencoded." } });
    }
    const out = await receiveSubmission({ slug, headers: req.headers, payload, ip: clientIp(req.headers) });
    return json(out.status, out.body, out.retryAfter ? { "Retry-After": String(out.retryAfter) } : {});
  } catch (err) {
    logger.error("lead_intake.error", { error: err instanceof Error ? err.message : String(err) });
    // 500 lets the sender retry; processing is idempotent.
    return json(500, { error: { code: "INTERNAL_ERROR", message: "Temporary problem. Please retry." } });
  }
}

export function GET() {
  return json(405, { error: { code: "METHOD_NOT_ALLOWED", message: "Use POST from your website's server." } }, { Allow: "POST" });
}
