import { readTwilioWebhook } from "@/lib/telephony/webhook";
import { rejectTwiml } from "@/lib/telephony/twilio";
import { logger } from "@/lib/logger";
import { voiceTwiml } from "@/modules/calls/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const xml = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" } });

/** TwiML App "Voice URL". Signature-validated; cross-site by design (called by Twilio, not browsers). */
export async function POST(req: Request) {
  try {
    const params = await readTwilioWebhook(req, "/api/v1/telephony/twilio/voice");
    if (!params) return new Response("Forbidden", { status: 403 });
    return xml(await voiceTwiml(params));
  } catch (err) {
    logger.error("telephony.voice_error", { error: err instanceof Error ? err : String(err) });
    return xml(rejectTwiml("This call could not be placed."));
  }
}
