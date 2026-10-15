import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import mongoose from "mongoose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@/lib/auth/password";
import { Client, e2eEnv, key, runCli, startApp, startSmtpSink, tokenIn } from "./harness";

/**
 * Acceptance journey over real HTTP against the production build, a throwaway
 * database (TEST_MONGODB_URI or an in-memory replica set) and a local SMTP
 * sink. Synthetic data only: example.test addresses and 555 numbers.
 */

const PASSWORD = "maple river lantern 4821";
const STAFF_PASSWORD = "copper meadow signal 7310";
const CLEANER_PASSWORD = "quiet harbor pebble 9264";
const NEW_PASSWORD = "silver orchard window 5517";

let app: { origin: string; proc: ChildProcess; logs: string[] };
let smtp: Awaited<ReturnType<typeof startSmtpSink>>;
let env: NodeJS.ProcessEnv;
let dbUri: string;
let stopMemory: (() => Promise<void>) | null = null;

const owner = () => new Client(app.origin);
const S: Record<string, string> = {}; // ids shared between steps
let ownerClient: Client;

function localDate(offsetDays: number) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

beforeAll(async () => {
  const dbName = `realtypacer_e2e_${randomBytes(4).toString("hex")}`;
  if (process.env.TEST_MONGODB_URI) {
    const u = new URL(process.env.TEST_MONGODB_URI);
    u.pathname = `/${dbName}`;
    dbUri = u.toString();
  } else {
    const { MongoMemoryReplSet } = await import("mongodb-memory-server");
    const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    dbUri = rs.getUri(dbName);
    stopMemory = async () => {
      await rs.stop();
    };
  }
  smtp = await startSmtpSink();
  const port = 3300 + Math.floor(Math.random() * 500);
  env = e2eEnv({ port, mongoUri: dbUri, smtpPort: smtp.port });
  const migrate = await runCli("sync-indexes.cjs", [], env);
  expect(migrate.code, migrate.out).toBe(0);
  app = await startApp(env);
  ownerClient = owner();
}, 600_000);

afterAll(async () => {
  app?.proc.kill("SIGTERM");
  await smtp?.stop();
  if (dbUri && /realtypacer_e2e_[a-f0-9]+/.test(dbUri)) {
    const c = await mongoose.createConnection(dbUri).asPromise();
    if (/^realtypacer_e2e_/.test(c.db!.databaseName)) await c.dropDatabase();
    await c.close();
  }
  await stopMemory?.();
}, 120_000);

describe("platform", () => {
  it("serves public pages with a nonce CSP, keeps private pages private and exposes only minimal health", async () => {
    const home = await fetch(`${app.origin}/`);
    expect(home.status).toBe(200);
    const csp = home.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(home.headers.get("x-request-id")).toBeTruthy();
    const html = await home.text();
    expect(html).toContain("RealtyPacer");
    expect(html).toContain('rel="canonical"');
    const sitemap = await (await fetch(`${app.origin}/sitemap.xml`)).text();
    expect(sitemap).not.toMatch(/dashboard|login|api/);
    expect((await fetch(`${app.origin}/robots.txt`)).status).toBe(200);
    expect((await fetch(`${app.origin}/manifest.webmanifest`)).status).toBe(200);
    const dash = await fetch(`${app.origin}/dashboard`, { redirect: "manual" });
    expect([302, 303, 307, 308]).toContain(dash.status);
    expect(dash.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(await (await fetch(`${app.origin}/api/v1/health`)).json()).toEqual({ status: "ok" });
    expect(await (await fetch(`${app.origin}/api/v1/ready`)).json()).toEqual({ status: "ready" });
    expect((await fetch(`${app.origin}/api/v1/system/status`)).status).toBe(401);
  });
});

describe("owner journey", () => {
  it("1–2. bootstraps the owner, accepts the setup link (verifies email) and signs in", async () => {
    const boot = await runCli("bootstrap-superadmin.cjs", ["--name", "E2E Owner", "--email", "owner@e2e.example.test", "--org-name", "E2E Cleaning Co"], env);
    expect(boot.code, boot.out).toBe(0);
    const token = boot.out.match(/accept-invitation\?token=([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeTruthy();
    const accept = await ownerClient.json("POST", "/api/v1/auth/accept-invitation", { token, password: PASSWORD });
    expect(accept.status, accept.text).toBe(200);
    expect((await ownerClient.json("POST", "/api/v1/auth/accept-invitation", { token, password: PASSWORD })).status).toBeGreaterThanOrEqual(400); // single use
    expect((await new Client(app.origin).signIn("owner@e2e.example.test", "wrong password here")).session).toBe(false);
    const login = await ownerClient.signIn("owner@e2e.example.test", PASSWORD);
    expect(login.session).toBe(true);
    const me = await ownerClient.json<{ role: string }>("GET", "/api/v1/account/profile");
    expect(me.data.role).toBe("SUPERADMIN");
  });

  it("3. invites staff by email", async () => {
    const r = await ownerClient.json<{ id: string }>("POST", "/api/v1/users", { email: "staff@e2e.example.test", name: "Sam Staff", role: "STAFF", permissionGrants: ["customers:write", "bookings:write", "pricing:read"] });
    expect(r.status, r.text).toBe(201);
    const mail = smtp.messages.find((m) => m.to.includes("staff@e2e.example.test"));
    expect(mail).toBeTruthy();
    S.staffToken = tokenIn(mail!, "/accept-invitation");
  });

  it("4–5. creates services, cleaner profiles and a customer with two addresses", async () => {
    const sofa = await ownerClient.json<{ id: string }>("POST", "/api/v1/services", { name: "Sofa cleaning", defaultPriceCents: 12000, durationMinutes: 90, unitLabel: "sofa" });
    const carpet = await ownerClient.json<{ id: string }>("POST", "/api/v1/services", { name: "Carpet cleaning", defaultPriceCents: 4500, durationMinutes: 30, unitLabel: "room" });
    expect(sofa.status, sofa.text).toBe(201);
    S.sofa = sofa.data.id;
    S.carpet = carpet.data.id;
    const ana = await ownerClient.json<{ id: string }>("POST", "/api/v1/cleaners", { name: "Ana Example", phone: "514-555-0111", email: "ana.cleaner@e2e.example.test" });
    const ben = await ownerClient.json<{ id: string }>("POST", "/api/v1/cleaners", { name: "Ben Example", phone: "514-555-0112" });
    S.ana = ana.data.id;
    S.ben = ben.data.id;
    const cust = await ownerClient.json<{ id: string }>("POST", "/api/v1/customers", {
      firstName: "Morgan",
      lastName: "Sample",
      phone: "(905) 555-0142",
      email: "morgan.sample@example.test",
      relationshipStartedAt: "2023-02-01",
      confirmDuplicate: true,
      primaryAddress: { label: "Home", line1: "10 Example Rd", city: "Mississauga", region: "ON", postalCode: "L5B 0A1", country: "Canada" },
    });
    expect(cust.status, cust.text).toBe(201);
    S.customer = cust.data.id;
    const second = await ownerClient.json<{ id: string }>("POST", `/api/v1/customers/${S.customer}/addresses`, { label: "Cottage", line1: "2 Lake Lane", city: "Toronto", region: "ON", country: "Canada", links: [{ label: "Listing", url: "https://example.test/listing/2" }] });
    expect(second.status, second.text).toBe(201);
    const addrs = await ownerClient.json<{ items: { id: string; city: string; mapUrl: string }[] }>("GET", `/api/v1/customers/${S.customer}/addresses`);
    expect(addrs.data.items).toHaveLength(2);
    expect(addrs.data.items.every((a) => a.mapUrl.startsWith("https://www.google.com/maps"))).toBe(true);
    S.address = addrs.data.items.find((a) => a.city === "Mississauga")!.id;
  });

  it("6–9. books a multi-service job, sees it in the calendar, rejects an overlap and reschedules", async () => {
    const date = localDate(2);
    S.bookingKey = key();
    const body = { idempotencyKey: S.bookingKey, customerId: S.customer, addressId: S.address, date, startTime: "10:00", durationMinutes: 120, lineItems: [{ serviceId: S.sofa, quantity: 1 }, { serviceId: S.carpet, quantity: 2 }], cleanerIds: [S.ana], instructions: "Use the side door", officeNotes: "OFFICE-ONLY-NOTE" };
    const b = await ownerClient.json<{ id: string; version: number; reference: string; subtotalCents: number }>("POST", "/api/v1/bookings", body);
    expect(b.status, b.text).toBe(201);
    expect(b.data.subtotalCents).toBe(21000);
    S.booking = b.data.id;
    const replay = await ownerClient.json<{ id: string }>("POST", "/api/v1/bookings", body);
    expect(replay.status).toBe(200);
    expect(replay.data.id).toBe(S.booking); // duplicate submission → same booking

    const cal = await ownerClient.json<{ id: string }[]>("GET", `/api/v1/calendar/events?start=${date}&end=${date}`);
    expect(JSON.stringify(cal.data)).toContain(S.booking);

    const overlap = await ownerClient.json("POST", "/api/v1/bookings", { ...body, idempotencyKey: key(), startTime: "11:00", durationMinutes: 60 });
    expect(overlap.status).toBe(409);
    expect(overlap.error?.code).toBe("SCHEDULE_CONFLICT");

    const moved = await ownerClient.json<{ version: number }>("PATCH", `/api/v1/bookings/${S.booking}`, { expectedVersion: b.data.version, date, startTime: "13:00", durationMinutes: 120 });
    expect(moved.status, moved.text).toBe(200);
    const stale = await ownerClient.json("PATCH", `/api/v1/bookings/${S.booking}`, { expectedVersion: b.data.version, date, startTime: "15:00", durationMinutes: 120 });
    expect(stale.error?.code).toBe("STALE_VERSION"); // stale edit never overwrites the newer change
    S.version = String(moved.data.version);
  });

  it("10–13. completes the job, finalizes charges, records partial + final payments and reconciles", async () => {
    let v = Number(S.version);
    for (const action of ["start", "complete"]) {
      const t = await ownerClient.json<{ version: number; status: string }>("POST", `/api/v1/bookings/${S.booking}/transition`, { action, expectedVersion: v });
      expect(t.status, t.text).toBe(200);
      v = t.data.version;
    }
    const fin = await ownerClient.json("POST", `/api/v1/bookings/${S.booking}/finalize`, { expectedVersion: v });
    expect(fin.status, fin.text).toBe(200);
    const today = localDate(0);
    const partialKey = key();
    const p1 = await ownerClient.json<{ id: string }>("POST", "/api/v1/payments", { idempotencyKey: partialKey, customerId: S.customer, amountCents: 10000, receivedDate: today, receivedTime: "00:05", method: "e_transfer", allocations: [] });
    expect(p1.status, p1.text).toBe(201);
    const p1again = await ownerClient.json<{ id: string }>("POST", "/api/v1/payments", { idempotencyKey: partialKey, customerId: S.customer, amountCents: 10000, receivedDate: today, receivedTime: "00:05", method: "e_transfer", allocations: [] });
    expect(p1again.data.id).toBe(p1.data.id); // no duplicate receipt
    let finance = await ownerClient.json<{ summary: { outstandingCents: number; unallocatedCreditCents: number }; openCharges: { lines: { lineItemId: string; balanceCents: number }[] }[] }>("GET", `/api/v1/customers/${S.customer}/finance`);
    expect(finance.data.summary).toMatchObject({ outstandingCents: 21000, unallocatedCreditCents: 10000 });
    // Apply the credit, then pay the rest.
    const lines = finance.data.openCharges[0]!.lines;
    const sofaLine = lines.find((l) => l.balanceCents === 12000)!;
    const alloc = await ownerClient.json("POST", `/api/v1/payments/${p1.data.id}/allocate`, { expectedRevision: 0, allocations: [{ bookingId: S.booking, lineItemId: sofaLine.lineItemId, amountCents: 10000 }] });
    expect(alloc.status, alloc.text).toBe(200);
    finance = await ownerClient.json("GET", `/api/v1/customers/${S.customer}/finance`);
    const remaining = finance.data.openCharges.flatMap((b) => b.lines).filter((l) => l.balanceCents > 0);
    const p2 = await ownerClient.json("POST", "/api/v1/payments", { idempotencyKey: key(), customerId: S.customer, amountCents: 11000, receivedDate: today, receivedTime: "00:06", method: "cash", allocations: remaining.map((l) => ({ bookingId: S.booking, lineItemId: l.lineItemId, amountCents: l.balanceCents })) });
    expect(p2.status, p2.text).toBe(201);
    finance = await ownerClient.json("GET", `/api/v1/customers/${S.customer}/finance`);
    expect(finance.data.summary).toMatchObject({ outstandingCents: 0, unallocatedCreditCents: 0 });
    const rec = await ownerClient.json<{ ok: boolean }>("GET", `/api/v1/customers/${S.customer}/reconcile`);
    expect(rec.data.ok).toBe(true);
    const history = await ownerClient.json<{ items: { id: string }[] }>("GET", `/api/v1/customers/${S.customer}/history`);
    expect(history.data.items.map((h) => h.id)).toContain(S.booking);
  });

  it("14–18. filters by city AND service AND date, custom field, points, saved view and CSV export", async () => {
    const today = localDate(0);
    const from = localDate(-5);
    const to = localDate(10);
    const def = { mode: "service", datePreset: "custom", from, to, statuses: ["COMPLETED"], filters: { logic: "and", conditions: [{ field: "city", op: "any_of", value: ["Mississauga"] }, { field: "service", op: "eq", value: S.sofa }] } };
    const run = await ownerClient.json<{ totals: Record<string, number>; rows: unknown[] }>("POST", "/api/v1/reports/run", { definition: def });
    expect(run.status, run.text).toBe(200);
    expect(run.data.totals).toMatchObject({ serviceLines: 1, chargedCents: 12000, paidCents: 12000, outstandingCents: 0 }); // service-specific, not the whole booking
    const toronto = await ownerClient.json<{ totals: Record<string, number> }>("POST", "/api/v1/reports/run", { definition: { ...def, filters: { logic: "and", conditions: [{ field: "city", op: "any_of", value: ["Toronto"] }] } } });
    expect(toronto.data.totals.serviceLines).toBe(0);
    const evil = await ownerClient.json("POST", "/api/v1/reports/run", { definition: { ...def, filters: { logic: "and", conditions: [{ field: "city", op: "$where", value: "1" }] } } });
    expect(evil.status).toBe(400);

    const cf = await ownerClient.json<{ key: string }>("POST", "/api/v1/custom-fields", { entityType: "customer", label: "Number of pets", dataType: "number", filterable: true, showInTable: true });
    expect(cf.status, cf.text).toBe(201);
    const cust = await ownerClient.json<Record<string, unknown>>("GET", `/api/v1/customers/${S.customer}`);
    const patch = await ownerClient.json("PATCH", `/api/v1/customers/${S.customer}`, { customerType: "individual", firstName: "Morgan", lastName: "Sample", phone: "(905) 555-0142", email: "morgan.sample@example.test", relationshipStartedAt: "2023-02-01", tags: [], notes: "", customFields: { [cf.data.key]: 2 } });
    expect(patch.status, patch.text).toBe(200);
    expect(cust.status).toBe(200);
    const f = Buffer.from(JSON.stringify([{ field: `cf:customer:${cf.data.key}`, op: "gt", value: 1 }])).toString("base64url");
    const list = await ownerClient.json<{ items: { id: string }[] }>("GET", `/api/v1/customers?f=${f}`);
    expect(list.data.items.map((c) => c.id)).toEqual([S.customer]);

    const grant = await ownerClient.json("POST", `/api/v1/customers/${S.customer}/loyalty`, { type: "grant", idempotencyKey: key(), points: 50, reason: "Completed job" });
    expect(grant.status, grant.text).toBe(201);
    expect((await ownerClient.json("POST", `/api/v1/customers/${S.customer}/loyalty`, { type: "redeem", idempotencyKey: key(), points: 80, reason: "Too many" })).status).toBe(409);
    const redeem = await ownerClient.json("POST", `/api/v1/customers/${S.customer}/loyalty`, { type: "redeem", idempotencyKey: key(), points: 20, reason: "Discount" });
    expect(redeem.status).toBe(201);
    const pts = await ownerClient.json<{ balance: number }>("GET", `/api/v1/customers/${S.customer}/loyalty`);
    expect(pts.data.balance).toBe(30);

    const view = await ownerClient.json("POST", "/api/v1/views", { name: "Mississauga sofa", visibility: "shared", definition: def });
    expect(view.status, view.text).toBe(201);
    const csv = await ownerClient.raw("/api/v1/reports/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition: def }) });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    const text = await csv.text();
    expect(text).toContain("Service city is any of Mississauga");
    expect(text).toContain("120.00");
    expect(today).toMatch(/^\d{4}-/);
  });

  it("19. customer & service filter, customer profile, leads intake and integrations over HTTP", async () => {
    const filter = await ownerClient.json<{ totals: Record<string, number> }>("POST", "/api/v1/reports/customer-services", { conditions: [{ field: "city", op: "eq", value: "Mississauga" }, { field: "service", op: "eq", value: S.sofa }] });
    expect(filter.status, filter.text).toBe(200);
    expect(filter.data.totals).toMatchObject({ customers: 1, services: 1, paidCents: 12000 });

    for (const [path, text] of [
      ["/dashboard/customer-filter", "Customer &amp; service filter"],
      [`/dashboard/customers/${S.customer}`, "Service history"],
      ["/dashboard/settings/integrations", "Not connected"],
      ["/dashboard/leads", "General / service"],
      ["/dashboard", "Customer &amp; service filter"],
    ] as const) {
      const page = await ownerClient.raw(path);
      expect(page.status, path).toBe(200);
      expect(await page.text(), path).toContain(text);
    }

    const src = await ownerClient.json<{ source: { slug: string; endpoint: string }; secret: string }>("POST", "/api/v1/lead-sources", { name: "Website – cleaning quote", defaultCategory: "general", fieldMap: { "your-name": "name" } });
    expect(src.status, src.text).toBe(201);
    expect(src.data.source.endpoint).toBe(`${app.origin}/api/v1/intake/leads/${src.data.source.slug}`);
    // Server-to-server: no cookies, no Origin header.
    const send = () =>
      fetch(src.data.source.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${src.data.secret}`, "content-type": "application/json", "idempotency-key": "wp-entry-1" },
        body: JSON.stringify({ "your-name": "Pat Prospect", phone: "905-555-0177", service: "Sofa cleaning", city: "Mississauga" }),
      });
    const first = await send();
    expect(first.status).toBe(201);
    const leadId = ((await first.json()) as { data: { id: string } }).data.id;
    expect((await send()).status).toBe(200);
    const wrong = await fetch(src.data.source.endpoint, { method: "POST", headers: { authorization: "Bearer rpk_wrong", "content-type": "application/json" }, body: "{}" });
    expect(wrong.status).toBe(401);
    const leads = await ownerClient.json<{ items: { id: string; name: string }[] }>("GET", "/api/v1/leads?category=general");
    expect(leads.data.items.map((l) => l.id)).toEqual([leadId]);
    const conv = await ownerClient.json<{ customerId: string }>("POST", `/api/v1/leads/${leadId}/convert`, { create: true });
    expect(conv.status, conv.text).toBe(200);
    const again = await ownerClient.json<{ customerId: string }>("POST", `/api/v1/leads/${leadId}/convert`, { create: true });
    expect(again.data.customerId).toBe(conv.data.customerId);

    const google = await ownerClient.json<{ configured: boolean; connection: unknown }>("GET", "/api/v1/integrations/google");
    expect(google.data).toMatchObject({ configured: false, connection: null });
  });

  it("queues and delivers an explicitly sent booking email through the worker", async () => {
    const off = await ownerClient.json<{ preview: { blocked: string | null } }>("GET", `/api/v1/bookings/${S.booking}/email?kind=booking_confirmation`);
    expect(off.data.preview.blocked).toMatch(/turned off/);
    expect((await ownerClient.json("PATCH", "/api/v1/organization", { notifications: { customerBookingEmails: "manual" } })).status).toBe(200);
    const k = key();
    const sent = await ownerClient.json("POST", `/api/v1/bookings/${S.booking}/email`, { kind: "booking_confirmation", idempotencyKey: k });
    expect(sent.status, sent.text).toBe(202);
    expect((await ownerClient.json("POST", `/api/v1/bookings/${S.booking}/email`, { kind: "booking_confirmation", idempotencyKey: k })).status).toBe(200);
    const before = smtp.messages.length;
    const worker = await runCli("worker.cjs", ["--once"], env);
    expect(worker.code, worker.out).toBe(0);
    const mails = smtp.messages.slice(before).filter((m) => m.to.includes("morgan.sample@example.test"));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.raw).not.toContain("OFFICE-ONLY-NOTE");
    const status = await ownerClient.json<{ worker: { healthy: boolean }; outbox: { counts: Record<string, number> } }>("GET", "/api/v1/system/status");
    expect(status.data.worker.healthy).toBe(true);
    expect(status.data.outbox.counts.sent).toBe(1);
  });
});

describe("cleaner journey", () => {
  let cleaner: Client;

  it("is invited from the cleaner profile, signs in and sees only their job (with a notification)", async () => {
    const inv = await ownerClient.json("POST", `/api/v1/cleaners/${S.ana}/invite`, {});
    expect(inv.status, inv.text).toBeLessThan(300);
    const mail = smtp.messages.find((m) => m.to.includes("ana.cleaner@e2e.example.test"));
    const token = tokenIn(mail!, "/accept-invitation");
    cleaner = new Client(app.origin);
    expect((await cleaner.json("POST", "/api/v1/auth/accept-invitation", { token, password: CLEANER_PASSWORD })).status).toBe(200);
    expect((await cleaner.signIn("ana.cleaner@e2e.example.test", CLEANER_PASSWORD)).session).toBe(true);

    // A future job for Ana (notification) and one for Ben (must stay invisible).
    const date = localDate(4);
    const mine = await ownerClient.json<{ id: string }>("POST", "/api/v1/bookings", { idempotencyKey: key(), customerId: S.customer, addressId: S.address, date, startTime: "09:00", durationMinutes: 60, lineItems: [{ serviceId: S.sofa, quantity: 1 }], cleanerIds: [S.ana], officeNotes: "OFFICE-ONLY-NOTE" });
    const bens = await ownerClient.json<{ id: string }>("POST", "/api/v1/bookings", { idempotencyKey: key(), customerId: S.customer, addressId: S.address, date, startTime: "13:00", durationMinutes: 60, lineItems: [{ serviceId: S.carpet, quantity: 1 }], cleanerIds: [S.ben] });
    S.anaJob = mine.data.id;
    S.benJob = bens.data.id;

    const jobs = await cleaner.json<{ jobs: { id: string }[] }>("GET", "/api/v1/bookings/my-jobs");
    expect(jobs.data.jobs.map((j) => j.id)).toContain(S.anaJob);
    expect(JSON.stringify(jobs.data)).not.toContain(S.benJob);
    const job = await cleaner.json<Record<string, unknown> & { address: { mapUrl: string }; customer: { phone: string } }>("GET", `/api/v1/bookings/${S.anaJob}`);
    expect(job.status).toBe(200);
    expect(job.data.address.mapUrl).toMatch(/^https:\/\//);
    expect(job.data.customer.phone).toBe("+19055550142");
    expect(job.text).not.toContain("OFFICE-ONLY-NOTE");
    expect(job.data.billing).toBeNull();
    const notes = await cleaner.json<{ items: { type: string }[] }>("GET", "/api/v1/notifications");
    expect(notes.data.items.map((n) => n.type)).toContain("assignment_added");
  });

  it("can start/complete their job and add before/after photos only when storage is configured", async () => {
    const job = await cleaner.json<{ version: number }>("GET", `/api/v1/bookings/${S.anaJob}`);
    const start = await cleaner.json("POST", `/api/v1/bookings/${S.anaJob}/transition`, { action: "start", expectedVersion: job.data.version });
    expect(start.status, start.text).toBe(200);
    const upload = await cleaner.json("POST", "/api/v1/attachments/uploads", { parentType: "booking", parentId: S.anaJob, category: "before_photo", fileName: "before.jpg", contentType: "image/jpeg", size: 1000 });
    expect(upload.status).toBe(503); // honest "storage not configured", not a fake success
    expect(upload.error?.code).toBe("STORAGE_NOT_CONFIGURED");
  });

  it("is refused other jobs, office data, money and reports", async () => {
    expect((await cleaner.json("GET", `/api/v1/bookings/${S.benJob}`)).status).toBe(404);
    expect((await cleaner.json("POST", `/api/v1/bookings/${S.benJob}/transition`, { action: "start", expectedVersion: 0 })).status).toBe(404);
    for (const path of ["/api/v1/customers", `/api/v1/customers/${S.customer}`, "/api/v1/payments", `/api/v1/customers/${S.customer}/finance`, `/api/v1/activities?bookingId=${S.anaJob}`, "/api/v1/system/status", "/api/v1/leads", "/api/v1/lead-sources", "/api/v1/integrations/google"]) {
      expect([403, 404], path).toContain((await cleaner.json("GET", path)).status);
    }
    expect((await cleaner.json("POST", "/api/v1/reports/run", { definition: { mode: "service", from: localDate(-1), to: localDate(1) } })).status).toBe(403);
    expect((await cleaner.json("POST", "/api/v1/reports/customer-services", { conditions: [] })).status).toBe(403);
    expect((await cleaner.raw("/api/v1/reports/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition: { mode: "service", from: localDate(-1), to: localDate(1) } }) })).status).toBe(403);
  });
});

describe("security and reliability", () => {
  it("rejects cross-site and cross-organization requests", async () => {
    expect((await ownerClient.json("POST", "/api/v1/customers", { firstName: "X", phone: "4165550000" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await ownerClient.json("POST", "/api/v1/customers", { firstName: "X", phone: "4165550000" }, { origin: null })).status).toBe(403);

    const conn = await mongoose.createConnection(dbUri).asPromise();
    const orgId = new mongoose.Types.ObjectId();
    await conn.collection("organizations").insertOne({ _id: orgId, name: "Other Org", displayName: "Other Org", timezone: "America/Toronto", currency: "CAD", createdAt: new Date(), updatedAt: new Date() });
    await conn.collection("users").insertOne({ organizationId: orgId, email: "other.admin@e2e.example.test", name: "Other Admin", role: "ADMIN", status: "active", permissionGrants: [], passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date(), sessionVersion: 0, createdAt: new Date(), updatedAt: new Date() });
    await conn.close();
    const other = new Client(app.origin);
    expect((await other.signIn("other.admin@e2e.example.test", PASSWORD)).session).toBe(true);
    expect((await other.json("GET", `/api/v1/customers/${S.customer}`)).status).toBe(404);
    expect((await other.json("GET", `/api/v1/bookings/${S.booking}`)).status).toBe(404);
    expect((await other.json("PATCH", `/api/v1/customers/${S.customer}`, { firstName: "Hacked", phone: "4165550000" })).status).toBe(404);
    expect((await other.json("POST", "/api/v1/payments", { idempotencyKey: key(), customerId: S.customer, amountCents: 100, receivedDate: localDate(0), receivedTime: "00:05", method: "cash" })).status).toBe(404);
  });

  it("password reset invalidates existing sessions; reset links are single-use", async () => {
    const staff = new Client(app.origin);
    expect((await staff.json("POST", "/api/v1/auth/accept-invitation", { token: S.staffToken, password: STAFF_PASSWORD })).status).toBe(200);
    expect((await staff.signIn("staff@e2e.example.test", STAFF_PASSWORD)).session).toBe(true);
    expect((await staff.json("GET", "/api/v1/account/profile")).status).toBe(200);
    const before = smtp.messages.length;
    expect((await new Client(app.origin).json("POST", "/api/v1/auth/forgot-password", { email: "staff@e2e.example.test" })).status).toBe(200);
    expect((await new Client(app.origin).json("POST", "/api/v1/auth/forgot-password", { email: "nobody@e2e.example.test" })).status).toBe(200); // no enumeration
    const mail = smtp.messages.slice(before).find((m) => m.to.includes("staff@e2e.example.test"))!;
    const token = tokenIn(mail, "/reset-password");
    const anon = new Client(app.origin);
    expect((await anon.json("POST", "/api/v1/auth/reset-password", { token, password: NEW_PASSWORD })).status).toBe(200);
    expect((await anon.json("POST", "/api/v1/auth/reset-password", { token, password: NEW_PASSWORD })).status).toBeGreaterThanOrEqual(400);
    expect((await staff.json("GET", "/api/v1/account/profile")).status).toBe(401);
    expect((await new Client(app.origin).signIn("staff@e2e.example.test", NEW_PASSWORD)).session).toBe(true);
  });

  it("neutralizes formula injection in exports", async () => {
    const evil = await ownerClient.json<{ id: string }>("POST", "/api/v1/customers", { customerType: "business", displayName: "=HYPERLINK(\"http://evil.example\")", phone: "4165550177", confirmDuplicate: true, primaryAddress: { line1: "1 Formula St", city: "Mississauga" } });
    expect(evil.status, evil.text).toBe(201);
    const csv = await ownerClient.raw("/api/v1/reports/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ definition: { mode: "customers", from: localDate(-30), to: localDate(30), statuses: ["SCHEDULED", "COMPLETED", "IN_PROGRESS", "CANCELLED"] } }) });
    const text = await csv.text();
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});
