import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { User } from "@/lib/db/models/user";
import { AuditEvent } from "@/lib/db/models/audit-event";
import * as usersRoute from "@/app/api/v1/users/route";
import * as userRoute from "@/app/api/v1/users/[id]/route";
import * as auditRoute from "@/app/api/v1/audit-events/route";
import * as orgRoute from "@/app/api/v1/organization/route";
import * as profileRoute from "@/app/api/v1/account/profile/route";
import { createOrg, createUser, ctx, jsonRequest, signInAs, signOut } from "./helpers/fixtures";
import { startSmtp } from "./helpers/smtp";

vi.mock("@/lib/auth/claims", () => ({ getSessionClaims: vi.fn() }));

async function setup() {
  const org = await createOrg();
  const otherOrg = await createOrg("Other Org");
  const owner = await createUser(org._id, { role: "SUPERADMIN" });
  const admin = await createUser(org._id, { role: "ADMIN" });
  const staff = await createUser(org._id, { role: "STAFF" });
  const outsider = await createUser(otherOrg._id, { role: "STAFF" });
  return { org, otherOrg, owner, admin, staff, outsider };
}

const patch = (id: string, body: unknown, headers?: Record<string, string>) =>
  userRoute.PATCH(jsonRequest(`/api/v1/users/${id}`, "PATCH", body, headers), ctx({ id }));

describe("authentication and authorization on /api/v1", () => {
  let smtp: Awaited<ReturnType<typeof startSmtp>>;
  beforeEach(async () => {
    smtp = await startSmtp("accept");
  });
  afterEach(async () => {
    await smtp.stop();
  });

  it("returns 401 without a session", async () => {
    await signOut();
    const res = await usersRoute.GET(jsonRequest("/api/v1/users", "GET"), ctx({}));
    expect(res.status).toBe(401);
    expect((await auditRoute.GET(jsonRequest("/api/v1/audit-events", "GET"), ctx({}))).status).toBe(401);
  });

  it("returns 403 for STAFF on admin endpoints", async () => {
    const { staff } = await setup();
    await signInAs(staff);
    expect((await usersRoute.GET(jsonRequest("/api/v1/users", "GET"), ctx({}))).status).toBe(403);
    expect((await usersRoute.POST(jsonRequest("/api/v1/users", "POST", { email: "x@example.test", name: "X", role: "STAFF" }), ctx({}))).status).toBe(403);
    expect((await auditRoute.GET(jsonRequest("/api/v1/audit-events", "GET"), ctx({}))).status).toBe(403);
  });

  it("never returns password hashes or session versions", async () => {
    const { owner } = await setup();
    await signInAs(owner);
    const res = await usersRoute.GET(jsonRequest("/api/v1/users?pageSize=50", "GET"), ctx({}));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("$argon2");
    expect(text).not.toContain("sessionVersion");
    // Only own-organization users are listed.
    expect(JSON.parse(text).data.total).toBe(3);
  });

  it("prevents ADMIN from granting SUPERADMIN or ADMIN, or managing a SUPERADMIN", async () => {
    const { admin, owner, staff } = await setup();
    await signInAs(admin);
    const invite = await usersRoute.POST(jsonRequest("/api/v1/users", "POST", { email: "boss@example.test", name: "Boss", role: "SUPERADMIN" }), ctx({}));
    expect(invite.status).toBe(403);
    expect((await patch(String(staff._id), { role: "ADMIN" })).status).toBe(403);
    expect((await patch(String(staff._id), { role: "SUPERADMIN" })).status).toBe(403);
    expect((await patch(String(owner._id), { status: "suspended" })).status).toBe(403);
    expect((await User.findById(staff._id).lean())?.role).toBe("STAFF");
  });

  it("rejects self role/status changes", async () => {
    const { owner } = await setup();
    await signInAs(owner);
    expect((await patch(String(owner._id), { role: "STAFF" })).status).toBe(403);
    expect((await patch(String(owner._id), { status: "suspended" })).status).toBe(403);
  });

  it("returns 404 for another organization's user id", async () => {
    const { owner, outsider } = await setup();
    await signInAs(owner);
    const res = await patch(String(outsider._id), { status: "suspended" });
    expect(res.status).toBe(404);
    expect((await User.findById(outsider._id).lean())?.status).toBe("active");
  });

  it("rejects mass assignment and operator injection", async () => {
    const { owner, staff } = await setup();
    await signInAs(owner);
    expect((await patch(String(staff._id), { passwordHash: "x" })).status).toBe(400);
    expect((await patch(String(staff._id), { organizationId: "000000000000000000000000" })).status).toBe(400);
    expect((await patch(String(staff._id), { role: { $ne: "STAFF" } })).status).toBe(400);
    const q = await usersRoute.GET(jsonRequest("/api/v1/users?role[$ne]=STAFF", "GET"), ctx({}));
    expect(q.status).toBe(200);
    const bad = await usersRoute.GET(jsonRequest("/api/v1/users?q=(a%2B)%2B%24", "GET"), ctx({}));
    expect(bad.status).toBe(200);
  });

  it("rejects cross-origin and non-JSON mutations (CSRF)", async () => {
    const { owner, staff } = await setup();
    await signInAs(owner);
    expect((await patch(String(staff._id), { status: "suspended" }, { origin: "https://evil.test" })).status).toBe(403);
    const form = new Request(`http://localhost:3000/api/v1/users/${staff._id}`, {
      method: "PATCH",
      headers: { origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" },
      body: "status=suspended",
    });
    expect((await userRoute.PATCH(form, ctx({ id: String(staff._id) }))).status).toBe(400);
    expect((await User.findById(staff._id).lean())?.status).toBe("active");
  });

  it("protects the last active SUPERADMIN", async () => {
    const { owner } = await setup();
    const second = await createUser(owner.organizationId, { role: "SUPERADMIN" });
    await signInAs(second);
    // With two active superadmins, demoting the other one is allowed…
    expect((await patch(String(owner._id), { role: "ADMIN" })).status).toBe(200);
    // …and the remaining one cannot demote or suspend themself.
    expect((await patch(String(second._id), { role: "ADMIN" })).status).toBe(403);

    // Service-level guard (e.g. an actor whose own access changed mid-request).
    const { resolveUser } = await import("@/lib/auth/current-user");
    const { updateUser } = await import("@/modules/users/service");
    const actor = (await resolveUser({ userId: String(second._id), organizationId: String(second.organizationId), sessionVersion: 0 })).user!;
    const ownerNow = (await User.findById(owner._id).lean())!;
    await User.updateOne({ _id: owner._id }, { $set: { role: "SUPERADMIN" } });
    await User.updateOne({ _id: second._id }, { $set: { status: "suspended" } });
    await expect(updateUser(actor, String(ownerNow._id), { role: "ADMIN" })).rejects.toMatchObject({ code: "LAST_SUPERADMIN" });
    expect(await User.countDocuments({ organizationId: owner.organizationId, role: "SUPERADMIN", status: "active" })).toBe(1);
  });

  it("refuses to demote the last active SUPERADMIN even under concurrency", async () => {
    const org = await createOrg();
    const a = await createUser(org._id, { role: "SUPERADMIN" });
    const b = await createUser(org._id, { role: "SUPERADMIN" });
    const c = await createUser(org._id, { role: "SUPERADMIN" });
    await signInAs(c);
    // c demotes a and b at the same time; at least one must remain besides c... then c tries.
    const results = await Promise.all([patch(String(a._id), { role: "ADMIN" }), patch(String(b._id), { role: "ADMIN" })]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await User.countDocuments({ organizationId: org._id, role: "SUPERADMIN", status: "active" })).toBe(1);

    // Two remaining superadmins demoting each other concurrently can't both succeed.
    await User.updateOne({ _id: a._id }, { $set: { role: "SUPERADMIN" } });
    const aNow = (await User.findById(a._id).lean())!;
    const cNow = (await User.findById(c._id).lean())!;
    const claims = await import("@/lib/auth/claims");
    vi.mocked(claims.getSessionClaims)
      .mockResolvedValueOnce({ userId: String(aNow._id), organizationId: String(org._id), sessionVersion: aNow.sessionVersion })
      .mockResolvedValueOnce({ userId: String(cNow._id), organizationId: String(org._id), sessionVersion: cNow.sessionVersion });
    await Promise.all([patch(String(c._id), { role: "ADMIN" }), patch(String(a._id), { role: "ADMIN" })]);
    expect(await User.countDocuments({ organizationId: org._id, role: "SUPERADMIN", status: "active" })).toBeGreaterThanOrEqual(1);
  });

  it("suspension revokes the user's session on their next request", async () => {
    const { owner, admin } = await setup();
    await signInAs(admin);
    expect((await usersRoute.GET(jsonRequest("/api/v1/users", "GET"), ctx({}))).status).toBe(200);
    const adminClaims = { _id: admin._id, organizationId: admin.organizationId, sessionVersion: admin.sessionVersion };

    await signInAs(owner);
    expect((await patch(String(admin._id), { status: "suspended" })).status).toBe(200);

    await signInAs(adminClaims);
    expect((await usersRoute.GET(jsonRequest("/api/v1/users", "GET"), ctx({}))).status).toBe(401);
    expect(await AuditEvent.countDocuments({ action: "user.suspended" })).toBe(1);

    // Reactivation does not resurrect the old session (sessionVersion moved on).
    await signInAs(owner);
    expect((await patch(String(admin._id), { status: "active" })).status).toBe(200);
    await signInAs(adminClaims);
    expect((await usersRoute.GET(jsonRequest("/api/v1/users", "GET"), ctx({}))).status).toBe(401);
  });

  it("lets ADMIN manage STAFF grants but strips non-grantable permissions", async () => {
    const { admin, staff } = await setup();
    await signInAs(admin);
    expect((await patch(String(staff._id), { permissionGrants: ["financials:read"] })).status).toBe(200);
    expect((await User.findById(staff._id).lean())?.permissionGrants).toEqual(["financials:read"]);
    expect((await patch(String(staff._id), { permissionGrants: ["users:manage"] })).status).toBe(400);
  });

  it("restricts protected organization settings to SUPERADMIN", async () => {
    const { admin, owner } = await setup();
    await signInAs(admin);
    expect((await orgRoute.PATCH(jsonRequest("/api/v1/organization", "PATCH", { currency: "USD" }), ctx({}))).status).toBe(403);
    expect((await orgRoute.PATCH(jsonRequest("/api/v1/organization", "PATCH", { displayName: "Sparkle" }), ctx({}))).status).toBe(200);
    await signInAs(owner);
    expect((await orgRoute.PATCH(jsonRequest("/api/v1/organization", "PATCH", { timezone: "Not/AZone" }), ctx({}))).status).toBe(400);
    expect((await orgRoute.PATCH(jsonRequest("/api/v1/organization", "PATCH", { currency: "USD", timezone: "America/Vancouver" }), ctx({}))).status).toBe(200);
  });

  it("lets any active user update their own profile name only", async () => {
    const { staff } = await setup();
    await signInAs(staff);
    expect((await profileRoute.PATCH(jsonRequest("/api/v1/account/profile", "PATCH", { name: "New Name" }), ctx({}))).status).toBe(200);
    expect((await profileRoute.PATCH(jsonRequest("/api/v1/account/profile", "PATCH", { name: "X", role: "SUPERADMIN" }), ctx({}))).status).toBe(400);
    expect((await User.findById(staff._id).lean())?.role).toBe("STAFF");
  });
});
