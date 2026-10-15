import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import { connectDb } from "@/lib/db/connect";
import { AuthToken } from "@/lib/db/models/auth-token";
import type { AuthTokenPurpose } from "@/lib/domain/constants";

export const TOKEN_TTL_MS: Record<AuthTokenPurpose, number> = {
  invitation: 72 * 60 * 60 * 1000,
  email_verification: 24 * 60 * 60 * 1000,
  password_reset: 30 * 60 * 1000,
};

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Raw tokens are 256-bit, base64url. Anything else is rejected before a DB lookup. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedToken(raw: unknown): raw is string {
  return typeof raw === "string" && TOKEN_FORMAT.test(raw);
}

export type IssuedToken = { raw: string; tokenId: Types.ObjectId; expiresAt: Date };

/**
 * Issues a new single-use token and revokes any outstanding tokens of the same
 * purpose for the user, so only the most recent link works.
 */
export async function issueToken(input: {
  userId: Types.ObjectId;
  organizationId: Types.ObjectId;
  purpose: AuthTokenPurpose;
  createdBy?: Types.ObjectId | null;
}): Promise<IssuedToken> {
  await connectDb();
  const now = new Date();
  await AuthToken.updateMany(
    { userId: input.userId, purpose: input.purpose, consumedAt: null, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS[input.purpose]);
  const doc = await AuthToken.create({
    userId: input.userId,
    organizationId: input.organizationId,
    purpose: input.purpose,
    tokenHash: hashToken(raw),
    expiresAt,
    createdBy: input.createdBy ?? null,
  });
  return { raw, tokenId: doc._id, expiresAt };
}

export type TokenState = "valid" | "invalid" | "expired" | "used";

export type ConsumeResult =
  | { ok: true; userId: Types.ObjectId; organizationId: Types.ObjectId; tokenId: Types.ObjectId }
  | { ok: false; reason: Exclude<TokenState, "valid"> };

/** Read-only check used to render the right page state before the user submits. */
export async function inspectToken(raw: unknown, purpose: AuthTokenPurpose): Promise<TokenState> {
  if (!isWellFormedToken(raw)) return "invalid";
  await connectDb();
  const doc = await AuthToken.findOne({ tokenHash: hashToken(raw), purpose }).lean();
  return stateOf(doc);
}

function stateOf(doc: { consumedAt?: Date | null; revokedAt?: Date | null; expiresAt: Date } | null): TokenState {
  if (!doc) return "invalid";
  if (doc.consumedAt) return "used";
  if (doc.revokedAt) return "invalid";
  if (doc.expiresAt.getTime() <= Date.now()) return "expired";
  return "valid";
}

/**
 * Atomically consumes a token: the filter only matches an unconsumed,
 * unrevoked, unexpired token, and the update marks it consumed in the same
 * operation — so a replayed or concurrent request cannot use it twice.
 */
export async function consumeToken(raw: unknown, purpose: AuthTokenPurpose): Promise<ConsumeResult> {
  if (!isWellFormedToken(raw)) return { ok: false, reason: "invalid" };
  await connectDb();
  const tokenHash = hashToken(raw);
  const now = new Date();
  const doc = await AuthToken.findOneAndUpdate(
    { tokenHash, purpose, consumedAt: null, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { consumedAt: now } },
    { returnDocument: "after" },
  ).lean();
  if (doc) return { ok: true, userId: doc.userId, organizationId: doc.organizationId, tokenId: doc._id };
  const existing = await AuthToken.findOne({ tokenHash, purpose }).lean();
  const state = stateOf(existing);
  return { ok: false, reason: state === "valid" ? "used" : state };
}

/** Releases a consumed token if the follow-up write failed, so the user can retry. */
export async function releaseToken(tokenId: Types.ObjectId) {
  await AuthToken.updateOne({ _id: tokenId }, { $set: { consumedAt: null } });
}

export async function recordDelivery(tokenId: Types.ObjectId, result: { ok: true } | { ok: false; code: string }) {
  await AuthToken.updateOne(
    { _id: tokenId },
    {
      $set: {
        "delivery.status": result.ok ? "sent" : "failed",
        "delivery.lastAttemptAt": new Date(),
        "delivery.lastErrorCode": result.ok ? null : result.code,
      },
      $inc: { "delivery.attempts": 1 },
    },
  );
}
