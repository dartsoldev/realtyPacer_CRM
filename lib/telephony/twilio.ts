import "server-only";
import twilio from "twilio";
import type { TwilioEnv } from "@/lib/env";

/**
 * Thin Twilio Voice adapter (official `twilio` Node library). Everything the
 * browser receives is a short-lived access token scoped to one TwiML app with
 * outgoing calls only; the account credentials never leave the server.
 */

/** Voice identities may contain only letters, digits and underscores. */
export function voiceIdentity(userId: string): string {
  return `rp_${userId.replace(/[^A-Za-z0-9_]/g, "")}`;
}

export const VOICE_TOKEN_TTL_SECONDS = 600;

export function createVoiceToken(env: TwilioEnv, identity: string, ttl = VOICE_TOKEN_TTL_SECONDS): string {
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(env.TWILIO_ACCOUNT_SID, env.TWILIO_API_KEY_SID, env.TWILIO_API_KEY_SECRET, { identity, ttl });
  token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: env.TWILIO_TWIML_APP_SID, incomingAllow: false }));
  return token.toJwt();
}

/**
 * Validates X-Twilio-Signature against the trusted public URL (APP_URL + path),
 * never the Host header of the incoming request.
 */
export function validTwilioSignature(authToken: string, signature: string | null, publicUrl: string, params: Record<string, string>): boolean {
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, publicUrl, params);
}

export function dialTwiml(opts: { callerId: string; to: string; statusCallbackUrl: string; timeLimitSeconds?: number }): string {
  const response = new twilio.twiml.VoiceResponse();
  const dial = response.dial({ callerId: opts.callerId, answerOnBridge: true, timeLimit: opts.timeLimitSeconds ?? 3600 });
  dial.number({ statusCallback: opts.statusCallbackUrl, statusCallbackEvent: ["initiated", "ringing", "answered", "completed"], statusCallbackMethod: "POST" }, opts.to);
  return response.toString();
}

export function rejectTwiml(message: string): string {
  const response = new twilio.twiml.VoiceResponse();
  response.say(message);
  response.hangup();
  return response.toString();
}
