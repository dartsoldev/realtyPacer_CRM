import "server-only";
import { clientIp } from "@/lib/http/request";
import { getCoreEnv, getTwilioEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { hit, RATE_LIMITS } from "@/lib/security/rate-limit";
import { validTwilioSignature } from "./twilio";

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Reads a Twilio webhook (form-encoded POST) and verifies its signature
 * against APP_URL + path. Returns null when the request must be refused.
 */
export async function readTwilioWebhook(req: Request, path: string): Promise<Record<string, string> | null> {
  const env = getTwilioEnv();
  if (!env) return null;
  const ip = clientIp(req.headers);
  if (ip && !(await hit(RATE_LIMITS.telephonyWebhookByIp, ip)).allowed) return null;
  if (!(req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return null;
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
  const url = `${getCoreEnv().APP_URL}${path}${new URL(req.url).search}`;
  if (!validTwilioSignature(env.TWILIO_AUTH_TOKEN, req.headers.get("x-twilio-signature"), url, params)) {
    logger.warn("telephony.bad_signature", { path });
    return null;
  }
  return params;
}
