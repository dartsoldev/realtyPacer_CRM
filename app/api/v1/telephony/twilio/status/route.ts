import { readTwilioWebhook } from "@/lib/telephony/webhook";
import { logger } from "@/lib/logger";
import { applyCallStatus } from "@/modules/calls/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Status callbacks for the dialed leg. Duplicates/out-of-order events are ignored (still 204). */
export async function POST(req: Request) {
  try {
    const params = await readTwilioWebhook(req, "/api/v1/telephony/twilio/status");
    if (!params) return new Response("Forbidden", { status: 403 });
    await applyCallStatus(params);
    return new Response(null, { status: 204 });
  } catch (err) {
    logger.error("telephony.status_error", { error: err instanceof Error ? err : String(err) });
    // 500 lets Twilio retry a transient failure; processing is idempotent.
    return new Response(null, { status: 500 });
  }
}
