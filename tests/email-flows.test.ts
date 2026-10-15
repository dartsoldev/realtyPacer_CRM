import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthToken } from "@/lib/db/models/auth-token";
import { User } from "@/lib/db/models/user";
import * as usersRoute from "@/app/api/v1/users/route";
import * as resendRoute from "@/app/api/v1/users/[id]/resend-invitation/route";
import * as acceptRoute from "@/app/api/v1/auth/accept-invitation/route";
import * as forgotRoute from "@/app/api/v1/auth/forgot-password/route";
import * as resetRoute from "@/app/api/v1/auth/reset-password/route";
import * as verifyRoute from "@/app/api/v1/auth/verify-email/route";
import * as resendVerifyRoute from "@/app/api/v1/auth/resend-verification/route";
import * as passwordRoute from "@/app/api/v1/account/password/route";
import { authenticateWithPassword } from "@/modules/auth/login";
import { createOrg, createUser, ctx, jsonRequest, signInAs, TEST_PASSWORD } from "./helpers/fixtures";
import { startSmtp, tokenFromMail } from "./helpers/smtp";

vi.mock("@/lib/auth/claims", () => ({ getSessionClaims: vi.fn() }));

const NEW_PASSWORD = "lanterns over the harbour at dusk";
let smtp: Awaited<ReturnType<typeof startSmtp>> | null = null;

afterEach(async () => {
  await smtp?.stop();
  smtp = null;
});

async function ownerSession() {
  const org = await createOrg();
  const owner = await createUser(org._id, { role: "SUPERADMIN" });
  await signInAs(owner);
  return { org, owner };
}

const invite = (body: unknown) => usersRoute.POST(jsonRequest("/api/v1/users", "POST", body), ctx({}));

describe("invitations", () => {
  it("returns a setup error and creates nothing when SMTP is not configured", async () => {
    await ownerSession();
    const res = await invite({ email: "new@example.test", name: "New", role: "STAFF" });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("SETUP_REQUIRED");
    expect(await User.exists({ email: "new@example.test" })).toBeNull();
  });

  it("reports SMTP rejection honestly and allows a retry", async () => {
    smtp = await startSmtp("reject");
    await ownerSession();
    const res = await invite({ email: "new@example.test", name: "New", role: "STAFF" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("EMAIL_DELIVERY_FAILED");
    const user = await User.findOne({ email: "new@example.test" }).lean();
    expect(user?.status).toBe("invited");
    const token = await AuthToken.findOne({ userId: user!._id }).lean();
    expect(token?.delivery?.status).toBe("failed");

    await smtp.stop();
    smtp = await startSmtp("accept");
    const retry = await resendRoute.POST(jsonRequest(`/api/v1/users/${user!._id}/resend-invitation`, "POST"), ctx({ id: String(user!._id) }));
    expect(retry.status).toBe(200);
    expect(smtp.messages).toHaveLength(1);
    // The failed first link was revoked by the resend.
    expect(await AuthToken.countDocuments({ userId: user!._id, revokedAt: null })).toBe(1);
  });

  it("delivers a single-use invitation that activates and verifies the account", async () => {
    smtp = await startSmtp("accept");
    await ownerSession();
    const res = await invite({ email: "Invitee@Example.test", name: "Invitee", role: "CLEANER" });
    expect(res.status).toBe(201);
    expect(smtp.messages).toHaveLength(1);
    const mail = smtp.messages[0]!;
    expect(mail.to).toEqual(["invitee@example.test"]);
    expect(mail.raw).toContain("text/plain");
    expect(mail.raw).toContain("text/html");
    const token = tokenFromMail(mail, "/accept-invitation");
    expect(mail.raw).toContain("http://localhost:3000/accept-invitation");

    // Weak password rejected without consuming the token.
    const weak = await acceptRoute.POST(jsonRequest("/api/v1/auth/accept-invitation", "POST", { token, password: "short" }), ctx({}));
    expect(weak.status).toBe(400);

    const ok = await acceptRoute.POST(jsonRequest("/api/v1/auth/accept-invitation", "POST", { token, password: NEW_PASSWORD }), ctx({}));
    expect(ok.status).toBe(200);
    const user = await User.findOne({ email: "invitee@example.test" }).lean();
    expect(user?.status).toBe("active");
    expect(user?.emailVerifiedAt).toBeTruthy();
    expect(await authenticateWithPassword({ email: "invitee@example.test", password: NEW_PASSWORD })).not.toBeNull();

    const replay = await acceptRoute.POST(jsonRequest("/api/v1/auth/accept-invitation", "POST", { token, password: NEW_PASSWORD }), ctx({}));
    expect(replay.status).toBe(410);
    expect((await replay.json()).error.code).toBe("TOKEN_USED");
  });

  it("rejects expired invitations", async () => {
    smtp = await startSmtp("accept");
    await ownerSession();
    await invite({ email: "late@example.test", name: "Late", role: "STAFF" });
    const token = tokenFromMail(smtp.messages[0]!, "/accept-invitation");
    await AuthToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1) } });
    const res = await acceptRoute.POST(jsonRequest("/api/v1/auth/accept-invitation", "POST", { token, password: NEW_PASSWORD }), ctx({}));
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("TOKEN_EXPIRED");
  });

  it("rejects duplicate emails", async () => {
    smtp = await startSmtp("accept");
    const { owner } = await ownerSession();
    const res = await invite({ email: owner.email.toUpperCase(), name: "Dup", role: "STAFF" });
    expect(res.status).toBe(409);
  });
});

describe("password reset", () => {
  it("gives the same response for unknown and known accounts", async () => {
    smtp = await startSmtp("accept");
    const org = await createOrg();
    await createUser(org._id, { email: "known@example.test" });
    const a = await forgotRoute.POST(jsonRequest("/api/v1/auth/forgot-password", "POST", { email: "known@example.test" }), ctx({}));
    const b = await forgotRoute.POST(jsonRequest("/api/v1/auth/forgot-password", "POST", { email: "unknown@example.test" }), ctx({}));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    expect(smtp.messages).toHaveLength(1);
  });

  it("hides SMTP failures from the public but records them for admins", async () => {
    smtp = await startSmtp("reject");
    const org = await createOrg();
    await createUser(org._id, { email: "known@example.test" });
    const res = await forgotRoute.POST(jsonRequest("/api/v1/auth/forgot-password", "POST", { email: "known@example.test" }), ctx({}));
    expect(res.status).toBe(200);
    expect((await AuthToken.findOne({ purpose: "password_reset" }).lean())?.delivery?.status).toBe("failed");
  });

  it("resets the password once, revokes sessions, and sends a change notice", async () => {
    smtp = await startSmtp("accept");
    const org = await createOrg();
    const user = await createUser(org._id, { email: "reset@example.test" });
    await forgotRoute.POST(jsonRequest("/api/v1/auth/forgot-password", "POST", { email: "reset@example.test" }), ctx({}));
    const token = tokenFromMail(smtp.messages[0]!, "/reset-password");
    const res = await resetRoute.POST(jsonRequest("/api/v1/auth/reset-password", "POST", { token, password: NEW_PASSWORD }), ctx({}));
    expect(res.status).toBe(200);
    const after = await User.findById(user._id).lean();
    expect(after?.sessionVersion).toBe(user.sessionVersion + 1);
    expect(await authenticateWithPassword({ email: "reset@example.test", password: TEST_PASSWORD })).toBeNull();
    expect(await authenticateWithPassword({ email: "reset@example.test", password: NEW_PASSWORD })).not.toBeNull();
    expect(smtp.messages).toHaveLength(2); // reset link + password-changed notice
    const replay = await resetRoute.POST(jsonRequest("/api/v1/auth/reset-password", "POST", { token, password: NEW_PASSWORD }), ctx({}));
    expect(replay.status).toBe(410);
  });

  it("does not issue resets for suspended users", async () => {
    smtp = await startSmtp("accept");
    const org = await createOrg();
    await createUser(org._id, { email: "sus@example.test", status: "suspended" });
    await forgotRoute.POST(jsonRequest("/api/v1/auth/forgot-password", "POST", { email: "sus@example.test" }), ctx({}));
    expect(smtp.messages).toHaveLength(0);
  });
});

describe("email verification", () => {
  it("resends and verifies, then the link cannot be reused", async () => {
    smtp = await startSmtp("accept");
    const org = await createOrg();
    await createUser(org._id, { email: "unv@example.test", verified: false });
    const resend = await resendVerifyRoute.POST(jsonRequest("/api/v1/auth/resend-verification", "POST", { email: "unv@example.test" }), ctx({}));
    expect(resend.status).toBe(200);
    const token = tokenFromMail(smtp.messages[0]!, "/verify-email");
    await expect(authenticateWithPassword({ email: "unv@example.test", password: TEST_PASSWORD })).rejects.toThrow("EmailNotVerified");
    expect((await verifyRoute.POST(jsonRequest("/api/v1/auth/verify-email", "POST", { token }), ctx({}))).status).toBe(200);
    expect(await authenticateWithPassword({ email: "unv@example.test", password: TEST_PASSWORD })).not.toBeNull();
    expect((await verifyRoute.POST(jsonRequest("/api/v1/auth/verify-email", "POST", { token }), ctx({}))).status).toBe(410);
  });
});

describe("authenticated password change", () => {
  it("requires the current password and revokes existing sessions", async () => {
    smtp = await startSmtp("accept");
    const org = await createOrg();
    const user = await createUser(org._id);
    await signInAs(user);
    const wrong = await passwordRoute.POST(jsonRequest("/api/v1/account/password", "POST", { currentPassword: "nope nope nope", newPassword: NEW_PASSWORD }), ctx({}));
    expect(wrong.status).toBe(400);
    const ok = await passwordRoute.POST(jsonRequest("/api/v1/account/password", "POST", { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }), ctx({}));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.notificationSent).toBe(true);
    // Same (old) session claims are now rejected.
    const again = await passwordRoute.POST(jsonRequest("/api/v1/account/password", "POST", { currentPassword: NEW_PASSWORD, newPassword: TEST_PASSWORD }), ctx({}));
    expect(again.status).toBe(401);
  });
});
