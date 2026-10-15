import "server-only";
import { createHash } from "node:crypto";
import { connectDb } from "@/lib/db/connect";
import { RateLimit } from "@/lib/db/models/rate-limit";
import { Errors } from "@/lib/http/errors";

export type RateLimitRule = { bucket: string; limit: number; windowSeconds: number };

export const RATE_LIMITS = {
  loginByEmail: { bucket: "login:email", limit: 10, windowSeconds: 15 * 60 },
  loginByIp: { bucket: "login:ip", limit: 50, windowSeconds: 15 * 60 },
  forgotByEmail: { bucket: "forgot:email", limit: 3, windowSeconds: 60 * 60 },
  forgotByIp: { bucket: "forgot:ip", limit: 20, windowSeconds: 60 * 60 },
  resendVerifyByEmail: { bucket: "verify-resend:email", limit: 3, windowSeconds: 60 * 60 },
  resendVerifyByIp: { bucket: "verify-resend:ip", limit: 20, windowSeconds: 60 * 60 },
  tokenSubmitByIp: { bucket: "token-submit:ip", limit: 30, windowSeconds: 15 * 60 },
  inviteByActor: { bucket: "invite:actor", limit: 30, windowSeconds: 60 * 60 },
  passwordChangeByUser: { bucket: "password-change:user", limit: 10, windowSeconds: 60 * 60 },
  browserCallByUser: { bucket: "call-browser:user", limit: 30, windowSeconds: 60 * 60 },
  browserCallByOrg: { bucket: "call-browser:org", limit: 300, windowSeconds: 24 * 60 * 60 },
  telephonyWebhookByIp: { bucket: "telephony-webhook:ip", limit: 600, windowSeconds: 60 },
  uploadByUser: { bucket: "upload:user", limit: 120, windowSeconds: 60 * 60 },
  importByUser: { bucket: "import:user", limit: 20, windowSeconds: 60 * 60 },
  bookingEmailByUser: { bucket: "booking-email:user", limit: 100, windowSeconds: 60 * 60 },
  contactByIp: { bucket: "contact:ip", limit: 5, windowSeconds: 60 * 60 },
} satisfies Record<string, RateLimitRule>;

function hashKey(bucket: string, identifier: string, windowIndex: number) {
  return createHash("sha256").update(`${bucket}|${identifier}|${windowIndex}`).digest("base64url");
}

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

/**
 * Fixed-window counter stored in MongoDB so limits are shared by every server
 * instance (no per-process memory). The increment is a single atomic upsert.
 * Identifiers are hashed so raw emails/IPs are never stored.
 */
export async function hit(rule: RateLimitRule, identifier: string): Promise<RateLimitResult> {
  await connectDb();
  const now = Date.now();
  const windowMs = rule.windowSeconds * 1000;
  const windowIndex = Math.floor(now / windowMs);
  const windowEnd = (windowIndex + 1) * windowMs;
  const key = hashKey(rule.bucket, identifier, windowIndex);

  const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowEnd) } };
  let doc;
  try {
    doc = await RateLimit.findOneAndUpdate({ key }, update, { upsert: true, returnDocument: "after" }).lean();
  } catch (err) {
    // Two concurrent first hits can race on the unique index; retry once.
    if ((err as { code?: number }).code === 11000) {
      doc = await RateLimit.findOneAndUpdate({ key }, update, { upsert: true, returnDocument: "after" }).lean();
    } else {
      throw err;
    }
  }
  const count = doc?.count ?? 1;
  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
  };
}

/** Applies each (rule, identifier) pair; throws 429 if any is exceeded. Null identifiers are skipped. */
export async function enforce(checks: Array<[RateLimitRule, string | null | undefined]>) {
  for (const [rule, id] of checks) {
    if (!id) continue;
    const result = await hit(rule, id);
    if (!result.allowed) throw Errors.rateLimited(result.retryAfterSeconds);
  }
}
