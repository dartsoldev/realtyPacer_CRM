import "server-only";
import type { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { contextualPasswordProblem, hashPassword, passwordSchema, verifyPassword } from "@/lib/auth/password";
import { consumeToken, hashToken, isWellFormedToken, issueToken, recordDelivery, releaseToken, TOKEN_TTL_MS, type TokenState } from "@/lib/auth/tokens";
import { connectDb } from "@/lib/db/connect";
import { AuthToken } from "@/lib/db/models/auth-token";
import { Organization } from "@/lib/db/models/organization";
import { User } from "@/lib/db/models/user";
import { normalizeEmail } from "@/lib/domain/normalize";
import { formatDateTime } from "@/lib/domain/time";
import { EmailDeliveryError, sendEmail } from "@/lib/email/mailer";
import { passwordChangedEmail, passwordResetEmail, verificationEmail } from "@/lib/email/templates";
import { getSmtpEnv } from "@/lib/env";
import { Errors } from "@/lib/http/errors";
import { clientIp } from "@/lib/http/request";
import { logger } from "@/lib/logger";
import { enforce, RATE_LIMITS } from "@/lib/security/rate-limit";
import { recordAudit } from "@/modules/audit/service";
import { appLink } from "./links";

type Headers_ = Headers | Record<string, string | string[] | undefined> | undefined;

export const emailOnlySchema = z.object({ email: z.string().trim().min(3).max(254).email("Enter a valid email address.") });
export const tokenSchema = z.object({ token: z.string().min(1).max(100) });
export const tokenPasswordSchema = z.object({ token: z.string().min(1).max(100), password: passwordSchema });
export const acceptInvitationSchema = tokenPasswordSchema.extend({ name: z.string().trim().min(1).max(120).optional() });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(200),
  newPassword: passwordSchema,
});

export type TokenFlowResult = { ok: true } | { ok: false; reason: Exclude<TokenState, "valid"> };

async function orgName(organizationId: Types.ObjectId | string): Promise<string> {
  const org = await Organization.findById(organizationId).select("displayName").lean();
  return org?.displayName ?? "your organization";
}

async function tokenSubmissionLimits(headers: Headers_) {
  // Tokens are 256-bit, so brute force is infeasible; this only throttles abuse
  // per client. (A global bucket would let anyone lock out legitimate users.)
  await enforce([[RATE_LIMITS.tokenSubmitByIp, clientIp(headers)]]);
}

/**
 * Looks up a token without consuming it, plus its user. Used to run password
 * checks (which need the user's email) before the atomic consume.
 */
async function peekToken(raw: string, purpose: "invitation" | "password_reset") {
  if (!isWellFormedToken(raw)) return { state: "invalid" as const };
  const doc = await AuthToken.findOne({ tokenHash: hashToken(raw), purpose }).lean();
  if (!doc) return { state: "invalid" as const };
  if (doc.consumedAt) return { state: "used" as const };
  if (doc.revokedAt) return { state: "invalid" as const };
  if (doc.expiresAt.getTime() <= Date.now()) return { state: "expired" as const };
  const user = await User.findById(doc.userId).lean();
  if (!user) return { state: "invalid" as const };
  return { state: "valid" as const, user };
}

function assertPasswordFitsContext(password: string, ctx: { email: string; name?: string }) {
  const problem = contextualPasswordProblem(password, ctx);
  if (problem) throw Errors.validation(problem, { password: [problem] });
}

// ---------------------------------------------------------------------------
// Invitation acceptance
// ---------------------------------------------------------------------------

export async function acceptInvitation(input: z.infer<typeof acceptInvitationSchema>, headers: Headers_): Promise<TokenFlowResult> {
  await tokenSubmissionLimits(headers);
  await connectDb();
  const peek = await peekToken(input.token, "invitation");
  if (peek.state !== "valid") return { ok: false, reason: peek.state };
  if (peek.user.status !== "invited") return { ok: false, reason: "invalid" };
  assertPasswordFitsContext(input.password, { email: peek.user.email, name: peek.user.name });

  const passwordHash = await hashPassword(input.password);
  const consumed = await consumeToken(input.token, "invitation");
  if (!consumed.ok) return { ok: false, reason: consumed.reason };

  const now = new Date();
  const res = await User.updateOne(
    { _id: consumed.userId, status: "invited" },
    {
      $set: {
        passwordHash,
        status: "active",
        // The invitation link was delivered to this address, proving ownership.
        emailVerifiedAt: now,
        passwordChangedAt: now,
        ...(input.name ? { name: input.name } : {}),
      },
      $inc: { sessionVersion: 1 },
    },
  );
  if (res.matchedCount === 0) return { ok: false, reason: "invalid" };
  await recordAudit({
    organizationId: consumed.organizationId,
    actorId: consumed.userId,
    action: "user.invitation_accepted",
    entityType: "user",
    entityId: consumed.userId,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export async function verifyEmail(token: string, headers: Headers_): Promise<TokenFlowResult> {
  await tokenSubmissionLimits(headers);
  const consumed = await consumeToken(token, "email_verification");
  if (!consumed.ok) return { ok: false, reason: consumed.reason };
  const res = await User.updateOne(
    { _id: consumed.userId, emailVerifiedAt: null },
    { $set: { emailVerifiedAt: new Date() } },
  );
  await recordAudit({
    organizationId: consumed.organizationId,
    actorId: consumed.userId,
    action: "auth.email_verified",
    entityType: "user",
    entityId: consumed.userId,
    metadata: { alreadyVerified: res.modifiedCount === 0 },
  });
  return { ok: true };
}

/** Sends a verification email to a user (used by resend and by the bootstrap CLI). */
export async function sendVerificationEmailTo(user: { _id: Types.ObjectId; organizationId: Types.ObjectId; email: string; name: string }) {
  const issued = await issueToken({ userId: user._id, organizationId: user.organizationId, purpose: "email_verification" });
  const email = verificationEmail({
    to: user.email,
    name: user.name,
    orgName: await orgName(user.organizationId),
    url: appLink("/verify-email", { token: issued.raw }),
    expiresHours: TOKEN_TTL_MS.email_verification / 3_600_000,
  });
  try {
    await sendEmail(email);
    await recordDelivery(issued.tokenId, { ok: true });
  } catch (err) {
    const code = err instanceof EmailDeliveryError ? err.code : "UNKNOWN";
    await recordDelivery(issued.tokenId, { ok: false, code });
    await recordAudit({ organizationId: user.organizationId, action: "email.delivery_failed", entityType: "user", entityId: user._id, metadata: { kind: "email_verification", code } });
    throw err;
  }
}

/**
 * Public resend. Always returns the same generic outcome whether or not the
 * account exists. SMTP must be configured (checked first, for everyone, so
 * the 503 reveals nothing about any account). Delivery failures for a real
 * account are logged and audited for administrators.
 */
export async function resendVerification(rawEmail: string, headers: Headers_): Promise<void> {
  getSmtpEnv();
  const email = normalizeEmail(rawEmail);
  await enforce([
    [RATE_LIMITS.resendVerifyByEmail, email],
    [RATE_LIMITS.resendVerifyByIp, clientIp(headers)],
  ]);
  await connectDb();
  const user = await User.findOne({ email, status: "active", emailVerifiedAt: null }).lean();
  if (!user) return;
  try {
    await sendVerificationEmailTo(user);
  } catch (err) {
    if (!(err instanceof EmailDeliveryError)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

export async function requestPasswordReset(rawEmail: string, headers: Headers_): Promise<void> {
  getSmtpEnv();
  const email = normalizeEmail(rawEmail);
  await enforce([
    [RATE_LIMITS.forgotByEmail, email],
    [RATE_LIMITS.forgotByIp, clientIp(headers)],
  ]);
  await connectDb();
  const user = await User.findOne({ email, status: "active" }).lean();
  if (!user) return;
  const issued = await issueToken({ userId: user._id, organizationId: user.organizationId, purpose: "password_reset" });
  const message = passwordResetEmail({
    to: user.email,
    name: user.name,
    orgName: await orgName(user.organizationId),
    url: appLink("/reset-password", { token: issued.raw }),
    expiresMinutes: TOKEN_TTL_MS.password_reset / 60_000,
  });
  try {
    await sendEmail(message);
    await recordDelivery(issued.tokenId, { ok: true });
    await recordAudit({ organizationId: user.organizationId, action: "auth.password_reset_requested", entityType: "user", entityId: user._id });
  } catch (err) {
    if (!(err instanceof EmailDeliveryError)) throw err;
    await recordDelivery(issued.tokenId, { ok: false, code: err.code });
    await recordAudit({ organizationId: user.organizationId, action: "email.delivery_failed", entityType: "user", entityId: user._id, metadata: { kind: "password_reset", code: err.code } });
  }
}

export async function resetPassword(input: z.infer<typeof tokenPasswordSchema>, headers: Headers_): Promise<TokenFlowResult> {
  await tokenSubmissionLimits(headers);
  await connectDb();
  const peek = await peekToken(input.token, "password_reset");
  if (peek.state !== "valid") return { ok: false, reason: peek.state };
  if (peek.user.status !== "active") return { ok: false, reason: "invalid" };
  assertPasswordFitsContext(input.password, { email: peek.user.email, name: peek.user.name });

  const passwordHash = await hashPassword(input.password);
  const consumed = await consumeToken(input.token, "password_reset");
  if (!consumed.ok) return { ok: false, reason: consumed.reason };

  const now = new Date();
  const res = await User.updateOne(
    { _id: consumed.userId, status: "active" },
    [
      {
        $set: {
          // $literal: argon2 hashes start with "$", which a pipeline would read as a field path.
          passwordHash: { $literal: passwordHash },
          passwordChangedAt: { $literal: now },
          // Receiving the reset link proves control of the address.
          emailVerifiedAt: { $ifNull: ["$emailVerifiedAt", now] },
          sessionVersion: { $add: ["$sessionVersion", 1] },
        },
      },
    ],
    { updatePipeline: true },
  );
  if (res.matchedCount === 0) {
    await releaseToken(consumed.tokenId);
    return { ok: false, reason: "invalid" };
  }
  await recordAudit({ organizationId: consumed.organizationId, actorId: consumed.userId, action: "auth.password_reset_completed", entityType: "user", entityId: consumed.userId });
  await notifyPasswordChanged(consumed.userId);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Authenticated password change
// ---------------------------------------------------------------------------

export async function changePassword(actor: CurrentUser, input: z.infer<typeof changePasswordSchema>): Promise<{ notificationSent: boolean }> {
  await enforce([[RATE_LIMITS.passwordChangeByUser, actor.id]]);
  await connectDb();
  const user = await User.findOne({ _id: actor.id, organizationId: actor.organizationId }).select("+passwordHash").lean();
  if (!user?.passwordHash) throw Errors.unauthenticated();
  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw Errors.validation("Your current password is incorrect.", { currentPassword: ["Your current password is incorrect."] });
  }
  if (input.currentPassword === input.newPassword) {
    throw Errors.validation("Choose a password you haven't used here.", { newPassword: ["Choose a different password."] });
  }
  assertPasswordFitsContext(input.newPassword, { email: user.email, name: user.name });
  const passwordHash = await hashPassword(input.newPassword);
  await User.updateOne(
    { _id: user._id },
    { $set: { passwordHash, passwordChangedAt: new Date() }, $inc: { sessionVersion: 1 } },
  );
  await recordAudit({ organizationId: user.organizationId, actorId: user._id, action: "auth.password_changed", entityType: "user", entityId: user._id });
  return { notificationSent: await notifyPasswordChanged(user._id) };
}

/** Best-effort security notification. Returns whether the SMTP server accepted it. */
async function notifyPasswordChanged(userId: Types.ObjectId): Promise<boolean> {
  try {
    const user = await User.findById(userId).lean();
    if (!user) return false;
    const org = await Organization.findById(user.organizationId).select("displayName timezone").lean();
    await sendEmail(
      passwordChangedEmail({
        to: user.email,
        name: user.name,
        orgName: org?.displayName ?? "your organization",
        when: formatDateTime(new Date(), org?.timezone ?? "UTC"),
        supportUrl: appLink("/forgot-password"),
      }),
    );
    return true;
  } catch (err) {
    logger.warn("auth.password_changed_notification_failed", { error: err as Error });
    return false;
  }
}
