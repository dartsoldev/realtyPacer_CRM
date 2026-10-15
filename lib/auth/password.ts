import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/domain/constants";

/**
 * Argon2id with OWASP-recommended parameters (19 MiB memory, 2 iterations,
 * 1 lane). @node-rs/argon2 defaults to the Argon2id variant; the PHC string
 * records the parameters so they can be raised later without a migration.
 */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/** Spends equivalent time when no user exists, to blunt account enumeration via timing. */
export async function burnPasswordVerification(password: string) {
  dummyHash ??= hashPassword("realtypacer-timing-equaliser-not-a-real-password");
  await verifyPassword(await dummyHash, password);
}

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters. A short passphrase works well.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`)
  .refine((p) => p.trim().length >= PASSWORD_MIN_LENGTH, "Password cannot be mostly spaces.")
  .refine((p) => new Set(p).size >= 5, "Password is too repetitive.");

/** Extra contextual checks that need user data. Returns an error message or null. */
export function contextualPasswordProblem(password: string, ctx: { email: string; name?: string }): string | null {
  const lower = password.toLowerCase();
  const local = ctx.email.split("@")[0]?.toLowerCase() ?? "";
  if (lower === ctx.email.toLowerCase() || (local.length >= 4 && lower.includes(local))) {
    return "Password must not contain your email address.";
  }
  if (["password", "realtypacer", "qwerty", "123456"].some((w) => lower.includes(w) && lower.length < 20)) {
    return "Password is too easy to guess. Try a longer passphrase.";
  }
  return null;
}
