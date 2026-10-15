import type { Types } from "mongoose";
import { vi } from "vitest";
import { hashPassword } from "@/lib/auth/password";
import { Organization } from "@/lib/db/models/organization";
import { User } from "@/lib/db/models/user";
import type { Role, UserStatus } from "@/lib/domain/constants";

export const TEST_PASSWORD = "correct horse battery staple";

export async function createOrg(name = "Test Cleaning Co") {
  return Organization.create({ name, displayName: name });
}

let counter = 0;
let cachedHash: string | null = null;

export async function createUser(
  orgId: Types.ObjectId,
  opts: { role?: Role; status?: UserStatus; verified?: boolean; email?: string; password?: string | null; grants?: string[] } = {},
) {
  counter += 1;
  const password = opts.password === undefined ? TEST_PASSWORD : opts.password;
  let passwordHash: string | undefined;
  if (password === TEST_PASSWORD) passwordHash = cachedHash ??= await hashPassword(TEST_PASSWORD);
  else if (password) passwordHash = await hashPassword(password);
  return User.create({
    organizationId: orgId,
    email: opts.email ?? `user${counter}-${Date.now()}@example.test`,
    name: `Test User ${counter}`,
    role: opts.role ?? "STAFF",
    status: opts.status ?? "active",
    emailVerifiedAt: opts.verified === false ? null : new Date(),
    permissionGrants: opts.grants ?? [],
    ...(passwordHash ? { passwordHash } : {}),
  });
}

/** Points the mocked session cookie at a user (as NextAuth would after login). */
export async function signInAs(user: { _id: unknown; organizationId: unknown; sessionVersion: number }) {
  const claims = await import("@/lib/auth/claims");
  vi.mocked(claims.getSessionClaims).mockResolvedValue({
    userId: String(user._id),
    organizationId: String(user.organizationId),
    sessionVersion: user.sessionVersion,
  });
}

export async function signOut() {
  const claims = await import("@/lib/auth/claims");
  vi.mocked(claims.getSessionClaims).mockResolvedValue(null);
}

export function jsonRequest(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers },
    body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
  });
}

export function ctx<P>(params: P) {
  return { params: Promise.resolve(params) };
}
