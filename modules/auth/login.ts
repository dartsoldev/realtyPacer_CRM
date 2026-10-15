import "server-only";
import { burnPasswordVerification, verifyPassword } from "@/lib/auth/password";
import { connectDb } from "@/lib/db/connect";
import { User } from "@/lib/db/models/user";
import { PASSWORD_MAX_LENGTH } from "@/lib/domain/constants";
import { normalizeEmail } from "@/lib/domain/normalize";
import { AppError } from "@/lib/http/errors";
import { clientIp } from "@/lib/http/request";
import { enforce, RATE_LIMITS } from "@/lib/security/rate-limit";
import { recordAudit } from "@/modules/audit/service";

/** Error codes surfaced to the login form (via NextAuth's `error` result). */
export const LOGIN_ERRORS = {
  RateLimited: "RateLimited",
  EmailNotVerified: "EmailNotVerified",
} as const;

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
  organizationId: string;
  sessionVersion: number;
};

/**
 * Verifies email + password. Returns null for every generic failure (unknown
 * email, wrong password, suspended or not-yet-activated account) so responses
 * don't reveal whether an account exists. Only after a *correct* password do
 * we reveal that the email is unverified.
 */
export async function authenticateWithPassword(input: {
  email: unknown;
  password: unknown;
  headers?: Headers | Record<string, string | string[] | undefined>;
}): Promise<AuthenticatedUser | null> {
  const { email, password } = input;
  if (typeof email !== "string" || typeof password !== "string") return null;
  if (email.length > 254 || password.length === 0 || password.length > PASSWORD_MAX_LENGTH) return null;
  const normalized = normalizeEmail(email);

  try {
    await enforce([
      [RATE_LIMITS.loginByEmail, normalized],
      [RATE_LIMITS.loginByIp, clientIp(input.headers)],
    ]);
  } catch (err) {
    if (err instanceof AppError && err.code === "RATE_LIMITED") throw new Error(LOGIN_ERRORS.RateLimited);
    throw err;
  }

  await connectDb();
  const user = await User.findOne({ email: normalized }).select("+passwordHash").lean();
  if (!user || !user.passwordHash) {
    await burnPasswordVerification(password);
    return null;
  }
  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) {
    await recordAudit({ organizationId: user.organizationId, actorId: null, action: "auth.login_failed", entityType: "user", entityId: user._id });
    return null;
  }
  if (user.status !== "active") return null;
  if (!user.emailVerifiedAt) throw new Error(LOGIN_ERRORS.EmailNotVerified);

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  await recordAudit({ organizationId: user.organizationId, actorId: user._id, action: "auth.login", entityType: "user", entityId: user._id });
  return {
    id: String(user._id),
    email: user.email,
    name: user.name,
    organizationId: String(user.organizationId),
    sessionVersion: user.sessionVersion,
  };
}
