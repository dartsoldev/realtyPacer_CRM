import { describe, expect, it, vi } from "vitest";
import { AuthToken } from "@/lib/db/models/auth-token";
import { User } from "@/lib/db/models/user";
import { consumeToken, inspectToken, issueToken } from "@/lib/auth/tokens";
import { resolveUser } from "@/lib/auth/current-user";
import { authenticateWithPassword } from "@/modules/auth/login";
import { createOrg, createUser, TEST_PASSWORD } from "./helpers/fixtures";

vi.mock("@/lib/auth/claims", () => ({ getSessionClaims: vi.fn() }));

describe("one-time tokens", () => {
  it("stores only a hash and can be consumed exactly once", async () => {
    const org = await createOrg();
    const user = await createUser(org._id, { status: "invited", password: null });
    const t = await issueToken({ userId: user._id, organizationId: org._id, purpose: "invitation" });
    const stored = await AuthToken.findById(t.tokenId).lean();
    expect(stored?.tokenHash).not.toContain(t.raw);
    expect(JSON.stringify(stored)).not.toContain(t.raw);

    expect(await inspectToken(t.raw, "invitation")).toBe("valid");
    expect((await consumeToken(t.raw, "invitation")).ok).toBe(true);
    expect(await consumeToken(t.raw, "invitation")).toEqual({ ok: false, reason: "used" });
  });

  it("allows only one winner under concurrent consumption", async () => {
    const org = await createOrg();
    const user = await createUser(org._id);
    const t = await issueToken({ userId: user._id, organizationId: org._id, purpose: "password_reset" });
    const results = await Promise.all(Array.from({ length: 8 }, () => consumeToken(t.raw, "password_reset")));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("rejects expired tokens even before the TTL monitor removes them", async () => {
    const org = await createOrg();
    const user = await createUser(org._id);
    const t = await issueToken({ userId: user._id, organizationId: org._id, purpose: "password_reset" });
    await AuthToken.updateOne({ _id: t.tokenId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await inspectToken(t.raw, "password_reset")).toBe("expired");
    expect(await consumeToken(t.raw, "password_reset")).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed, wrong-purpose and superseded tokens", async () => {
    const org = await createOrg();
    const user = await createUser(org._id);
    const first = await issueToken({ userId: user._id, organizationId: org._id, purpose: "email_verification" });
    await issueToken({ userId: user._id, organizationId: org._id, purpose: "email_verification" });
    expect(await consumeToken(first.raw, "email_verification")).toEqual({ ok: false, reason: "invalid" });
    expect(await consumeToken({ $ne: null }, "email_verification")).toEqual({ ok: false, reason: "invalid" });
    expect(await consumeToken("short", "email_verification")).toEqual({ ok: false, reason: "invalid" });
    const reset = await issueToken({ userId: user._id, organizationId: org._id, purpose: "password_reset" });
    expect(await consumeToken(reset.raw, "invitation")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("password login", () => {
  it("succeeds for an active, verified user", async () => {
    const org = await createOrg();
    const user = await createUser(org._id, { email: "active@example.test" });
    const result = await authenticateWithPassword({ email: " ACTIVE@example.test ", password: TEST_PASSWORD });
    expect(result?.id).toBe(String(user._id));
  });

  it("returns a generic null for wrong password, unknown email, suspended and invited users", async () => {
    const org = await createOrg();
    await createUser(org._id, { email: "a@example.test" });
    await createUser(org._id, { email: "s@example.test", status: "suspended" });
    await createUser(org._id, { email: "i@example.test", status: "invited" });
    expect(await authenticateWithPassword({ email: "a@example.test", password: "wrong password!!" })).toBeNull();
    expect(await authenticateWithPassword({ email: "nobody@example.test", password: TEST_PASSWORD })).toBeNull();
    expect(await authenticateWithPassword({ email: "s@example.test", password: TEST_PASSWORD })).toBeNull();
    expect(await authenticateWithPassword({ email: "i@example.test", password: TEST_PASSWORD })).toBeNull();
    expect(await authenticateWithPassword({ email: { $ne: "" }, password: TEST_PASSWORD })).toBeNull();
  });

  it("blocks unverified users only after a correct password", async () => {
    const org = await createOrg();
    await createUser(org._id, { email: "u@example.test", verified: false });
    await expect(authenticateWithPassword({ email: "u@example.test", password: TEST_PASSWORD })).rejects.toThrow("EmailNotVerified");
    expect(await authenticateWithPassword({ email: "u@example.test", password: "not the password" })).toBeNull();
  });

  it("rate-limits repeated attempts per email", async () => {
    const org = await createOrg();
    await createUser(org._id, { email: "rl@example.test" });
    for (let i = 0; i < 10; i++) await authenticateWithPassword({ email: "rl@example.test", password: "wrong password!!" });
    await expect(authenticateWithPassword({ email: "rl@example.test", password: TEST_PASSWORD })).rejects.toThrow("RateLimited");
  });
});

describe("session validation", () => {
  it("revokes sessions on sessionVersion change, suspension, and org mismatch", async () => {
    const org = await createOrg();
    const other = await createOrg("Other Org");
    const user = await createUser(org._id, { role: "ADMIN" });
    const claims = { userId: String(user._id), organizationId: String(org._id), sessionVersion: 0 };
    expect((await resolveUser(claims)).user?.role).toBe("ADMIN");

    expect((await resolveUser({ ...claims, organizationId: String(other._id) })).user).toBeNull();

    await User.updateOne({ _id: user._id }, { $inc: { sessionVersion: 1 } });
    expect(await resolveUser(claims)).toEqual({ user: null, reason: "revoked" });

    await User.updateOne({ _id: user._id }, { $set: { status: "suspended" } });
    expect((await resolveUser({ ...claims, sessionVersion: 1 })).user).toBeNull();
    expect(await resolveUser(null)).toEqual({ user: null, reason: "no_session" });
  });

  it("reads role from the database, so demotions apply immediately", async () => {
    const org = await createOrg();
    const user = await createUser(org._id, { role: "ADMIN" });
    const claims = { userId: String(user._id), organizationId: String(org._id), sessionVersion: 0 };
    await User.updateOne({ _id: user._id }, { $set: { role: "STAFF" } });
    const resolved = await resolveUser(claims);
    expect(resolved.user?.role).toBe("STAFF");
    expect(resolved.user?.permissions.has("users:invite")).toBe(false);
  });
});
