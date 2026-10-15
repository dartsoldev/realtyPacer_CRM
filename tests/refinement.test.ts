import { randomBytes } from "node:crypto";
import type { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarSync, GoogleCalendarConnection, OAuthState } from "@/lib/db/models/google-calendar";
import { Customer } from "@/lib/db/models/customer";
import { Lead, LeadSubmissionLog } from "@/lib/db/models/lead";
import { googleMapsUrl } from "@/lib/domain/links";
import { addDaysToKey, localDateKey } from "@/lib/domain/zoned-time";
import { decryptSecret, encryptSecret } from "@/lib/security/encryption";
import { changeBookingAddress, createBooking, operationsSummary, transitionBooking, updateBooking } from "@/modules/bookings/service";
import { assignableCleaners, createCleaner } from "@/modules/cleaners/service";
import { createDefinition, updateDefinition } from "@/modules/custom-fields/service";
import { listAddresses, updateAddress } from "@/modules/customers/addresses";
import { customerMetrics, customerServiceLines, lookupCustomers, updateCustomerCustomFields } from "@/modules/customers/service";
import { completeGoogleConnect, googleBusy, googleStatus, processCalendarSyncBatch, queueCalendarSync, retryCalendarSync, startGoogleConnect } from "@/modules/integrations/google-calendar";
import { createLeadSource, INTAKE_LIMITS, leadSourceLogs, listLeadSources, rotateLeadSourceSecret, updateLeadSource } from "@/modules/leads/intake";
import { conversionMatches, convertLead, createLead, getLead, importLeadsCsv, listLeads, updateLead } from "@/modules/leads/service";
import { runCustomerFilter } from "@/modules/reports/customer-filter";
import * as intakeRoute from "@/app/api/v1/intake/leads/[slug]/route";
import { createOrg, createUser } from "./helpers/fixtures";
import { actorFor, bookingBody, opsWorld } from "./helpers/ops-fixtures";
import { customerIn, finalizedBooking, key, pay } from "./helpers/finance-fixtures";

vi.mock("@/lib/auth/claims", () => ({ getSessionClaims: vi.fn() }));

/**
 * The client's workflow, with synthetic data only (example.test, 555 numbers):
 * two Mississauga customers and one in Toronto, sofa + carpet services, real
 * recorded payments.
 */
async function clientWorld() {
  const w = await opsWorld();
  const { admin, sofa, carpet } = w;
  const S = String(sofa._id);
  const C = String(carpet._id);
  const alice = await customerIn(admin, "Mississauga", "Alice");
  const bob = await customerIn(admin, "Mississauga", "Bob");
  const carl = await customerIn(admin, "Toronto", "Carl");
  // Alice: sofa + carpet in one visit, both paid in full; plus $20 she paid that was never applied.
  const a = await finalizedBooking(admin, alice, [{ serviceId: S, unitPriceCents: 12000 }, { serviceId: C, unitPriceCents: 4500 }], { cleanerIds: [String(w.ana._id)] });
  await pay(admin, alice.customer.id, 16500, [{ bookingId: a.id, lineItemId: a.lineFor(S), amountCents: 12000 }, { bookingId: a.id, lineItemId: a.lineFor(C), amountCents: 4500 }]);
  await pay(admin, alice.customer.id, 2000);
  // Bob: sofa $100, paid $60 so far (the unpaid $40 must not count).
  const b = await finalizedBooking(admin, bob, [{ serviceId: S, unitPriceCents: 10000 }], { date: "2026-07-02" });
  await pay(admin, bob.customer.id, 6000, [{ bookingId: b.id, lineItemId: b.lineFor(S), amountCents: 6000 }], "2026-07-03");
  // Bob also has a future sofa booking (not completed: excluded by default).
  await createBooking(admin, bookingBody({ customerId: bob.customer.id, addressId: bob.address.id, serviceId: S, date: "2031-05-05", startTime: "09:00" }));
  // Carl: sofa in Toronto, paid.
  const c = await finalizedBooking(admin, carl, [{ serviceId: S, unitPriceCents: 9000 }]);
  await pay(admin, carl.customer.id, 9000, [{ bookingId: c.id, lineItemId: c.lineFor(S), amountCents: 9000 }]);
  return { ...w, S, C, alice, bob, carl, a, b, c };
}

describe("customer & service filter (Mississauga AND Sofa)", () => {
  it("matches the right customers with per-customer and full-result totals, excluding other cities, carpet and unpaid amounts", async () => {
    const { admin, S, C, alice, bob } = await clientWorld();
    const conditions = [
      { field: "city", op: "eq", value: "Mississauga" },
      { field: "service", op: "eq", value: S },
    ];
    const res = await runCustomerFilter(admin, { conditions, columns: ["phone", "points"] });
    expect(res.totals).toEqual({ customers: 2, bookings: 2, services: 2, paidCents: 18000 });
    const byName = new Map(res.rows.map((r) => [r.customerId, r]));
    expect(byName.get(alice.customer.id)?.paidCents).toBe(12000); // carpet $45 excluded
    expect(byName.get(bob.customer.id)?.paidCents).toBe(6000); // unpaid $40 excluded
    expect(res.rows.flatMap((r) => r.lines.map((l) => l.service))).toEqual(["Sofa cleaning", "Sofa cleaning"]);
    expect(res.rows.every((r) => r.lines.every((l) => l.city === "Mississauga"))).toBe(true);
    expect(byName.get(alice.customer.id)?.lines[0]?.cleaners).toEqual(["Ana Test"]);
    // Money paid but never applied to a service is reported, not split.
    expect(res.unattributed).toEqual({ cents: 2000, customers: 1 });
    // Points appear once per customer.
    expect(byName.get(alice.customer.id)?.columns.points).toBe(0);

    // Totals cover the whole result, not the visible page.
    const paged = await runCustomerFilter(admin, { conditions, pageSize: 1 });
    expect(paged.rows).toHaveLength(1);
    expect(paged.totals).toEqual(res.totals);

    // Several values in one filter mean "any of".
    const any = await runCustomerFilter(admin, { conditions: [conditions[0]!, { field: "service", op: "any_of", value: [S, C] }] });
    expect(any.totals).toEqual({ customers: 2, bookings: 2, services: 3, paidCents: 22500 });

    // Including scheduled jobs needs an explicit status filter.
    const withScheduled = await runCustomerFilter(admin, { conditions: [...conditions, { field: "status", op: "any_of", value: ["COMPLETED", "SCHEDULED"] }] });
    expect(withScheduled.totals.bookings).toBe(3);
    expect(withScheduled.totals.paidCents).toBe(18000);
  });

  it("filters by service date and customer name", async () => {
    const { admin, S } = await clientWorld();
    const july = await runCustomerFilter(admin, { conditions: [{ field: "service", op: "eq", value: S }, { field: "serviceDate", op: "between", value: ["2026-07-01", "2026-07-31"] }] });
    expect(july.rows.map((r) => r.name)).toEqual(["Bob Fixture"]);
    const named = await runCustomerFilter(admin, { conditions: [{ field: "customerName", op: "contains", value: "carl" }] });
    expect(named.totals).toMatchObject({ customers: 1, services: 1, paidCents: 9000 });
  });

  it("uses a custom field as a column and a filter, and keeps values when the label changes", async () => {
    const { admin, alice, bob } = await clientWorld();
    const def = await createDefinition(admin, { entityType: "customer", dataType: "single_select", label: "Referral", options: [{ label: "Google" }, { label: "Friend" }], showInTable: true, filterable: true });
    const google = def.options.find((o) => o.label === "Google")!.value;
    await updateCustomerCustomFields(admin, alice.customer.id, { customFields: { [def.key]: google } });
    const cityAndReferral = [
      { field: "city", op: "eq", value: "Mississauga" },
      { field: `cf:customer:${def.key}`, op: "eq", value: google },
    ];
    const res = await runCustomerFilter(admin, { conditions: cityAndReferral, columns: [`cf:${def.key}`] });
    expect(res.rows.map((r) => r.customerId)).toEqual([alice.customer.id]);
    expect(res.rows[0]!.columns[`cf:${def.key}`]).toBe(google);
    expect(res.columns).toEqual([{ key: `cf:${def.key}`, label: "Referral" }]);
    expect(res.rows.some((r) => r.customerId === bob.customer.id)).toBe(false);

    await updateDefinition(admin, def.id, { label: "Referral source" });
    const renamed = await runCustomerFilter(admin, { conditions: cityAndReferral, columns: [`cf:${def.key}`] });
    expect(renamed.columns[0]!.label).toBe("Referral source");
    expect(renamed.rows[0]!.columns[`cf:${def.key}`]).toBe(google);

    // Points and money are system-calculated, not custom fields.
    await expect(createDefinition(admin, { entityType: "customer", dataType: "number", label: "Points" })).rejects.toThrow();
    await expect(createDefinition(admin, { entityType: "customer", dataType: "number", label: "Total paid" })).rejects.toThrow();
  });
});

describe("customer profile", () => {
  it("lists one row per service with the amount actually paid, separates bookings from services, and keeps past addresses when the address is edited", async () => {
    const { admin, S, alice } = await clientWorld();
    const history = await customerServiceLines(admin, alice.customer.id, { scope: "history" });
    expect(history.items.map((i) => [i.service, i.paidCents, i.city, i.status])).toEqual(
      expect.arrayContaining([
        ["Sofa cleaning", 12000, "Mississauga", "COMPLETED"],
        ["Carpet cleaning", 4500, "Mississauga", "COMPLETED"],
      ]),
    );
    expect(history.items[0]!.cleaners.map((c) => c.name)).toEqual(["Ana Test"]);
    const doc = await Customer.findById(alice.customer.id).lean();
    const m = await customerMetrics(doc!.organizationId, doc!._id, "America/Toronto");
    expect(m.completedBookings).toBe(1);
    expect(m.completedServices).toBe(2);

    const before = (await listAddresses(admin, alice.customer.id))[0]!;
    const oldMap = googleMapsUrl(before);
    const future = await createBooking(admin, bookingBody({ customerId: alice.customer.id, addressId: before.id, serviceId: S, date: "2031-03-03", startTime: "09:00" }));
    expect((await customerServiceLines(admin, alice.customer.id, { scope: "upcoming" })).items[0]!.outdatedAddress).toBeNull();
    await updateAddress(admin, alice.customer.id, before.id, { label: "Home", line1: "9 New Road", line2: "", city: "Oakville", region: "ON", postalCode: "", country: "Canada", accessInstructions: "", isPrimary: true, links: [] });
    const after = (await listAddresses(admin, alice.customer.id))[0]!;
    expect(after.city).toBe("Oakville");
    expect(googleMapsUrl(after)).not.toBe(oldMap);
    expect(googleMapsUrl(after)).toContain("Oakville");
    const again = await customerServiceLines(admin, alice.customer.id, { scope: "history" });
    expect(again.items.every((i) => i.city === "Mississauga" && i.address.includes("Alice Street"))).toBe(true);
    // The upcoming job still has the old snapshot: flagged until staff move it explicitly.
    const upcoming = (await customerServiceLines(admin, alice.customer.id, { scope: "upcoming" })).items[0]!;
    expect(upcoming.city).toBe("Mississauga");
    expect(upcoming.outdatedAddress).toEqual({ addressId: before.id, version: future.booking.version, current: "9 New Road, Oakville" });
    await changeBookingAddress(admin, future.booking.id, { addressId: before.id, expectedVersion: future.booking.version });
    const moved = (await customerServiceLines(admin, alice.customer.id, { scope: "upcoming" })).items[0]!;
    expect(moved).toMatchObject({ city: "Oakville", outdatedAddress: null });
  });

  it("hides paid amounts from users without financial access", async () => {
    const { org, alice } = await clientWorld();
    const staff = await actorFor(await createUser(org._id, { role: "STAFF" }));
    const rows = await customerServiceLines(staff, alice.customer.id, { scope: "history" });
    expect(rows.items.every((i) => i.paidCents === null)).toBe(true);
  });
});

describe("booking flow and calendar", () => {
  it("finds customers and cleaners by typing, shows unassigned and tomorrow's jobs with customer, service, place, cleaner and status", async () => {
    const { admin, S, alice, ana } = await clientWorld();
    expect((await lookupCustomers(admin, "alice")).items.map((c) => c.id)).toContain(alice.customer.id);
    expect((await assignableCleaners(admin)).map((c) => c.name)).toEqual(expect.arrayContaining(["Ana Test", "Ben Test"]));
    const tomorrow = addDaysToKey(localDateKey(new Date(), "America/Toronto"), 1);
    const { booking } = await createBooking(admin, bookingBody({ customerId: alice.customer.id, addressId: alice.address.id, serviceId: S, date: tomorrow, startTime: "13:00", cleanerIds: [String(ana._id)] }));
    const unassigned = await createBooking(admin, bookingBody({ customerId: alice.customer.id, addressId: alice.address.id, serviceId: S, date: tomorrow, startTime: "16:00" }));
    const ops = await operationsSummary(admin, {});
    const t = ops.tomorrowJobs.find((b) => b.id === booking.id)!;
    expect(t.customer.name).toBe("Alice Fixture");
    expect(t.customer.id).toBe(alice.customer.id);
    expect(t.lineItems[0]!.name).toBe("Sofa cleaning");
    expect(t.address.city).toBe("Mississauga");
    expect(t.cleaners.map((c) => [c.id, c.name])).toEqual([[String(ana._id), "Ana Test"]]);
    expect(t.status).toBe("SCHEDULED");
    expect(ops.unassignedJobs.map((b) => b.id)).toContain(unassigned.booking.id);
  });

  it("requires a cleaner's name and phone, email optional, with no sign-in created", async () => {
    const { admin } = await opsWorld();
    await expect(createCleaner(admin, { name: "Dee Test" })).rejects.toThrow();
    const c = await createCleaner(admin, { name: "Dee Test", phone: "416-555-0177" });
    expect(c.phone).toBe("+14165550177");
    expect(c.linkedUser ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

function intake(slug: string, secret: string | null, body: unknown, opts: { form?: boolean; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": opts.form ? "application/x-www-form-urlencoded" : "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...opts.headers };
  const payload = opts.form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body);
  return intakeRoute.POST(new Request(`http://localhost:3000/api/v1/intake/leads/${slug}`, { method: "POST", headers, body: payload }), { params: Promise.resolve({ slug }) });
}

describe("lead intake endpoint", () => {
  afterEach(() => {
    INTAKE_LIMITS.perSource.limit = 120;
  });

  it("accepts a service lead and a real estate lead from separate sources, maps fields and ignores retries", async () => {
    const { admin } = await opsWorld();
    const svc = await createLeadSource(admin, { name: "Website – cleaning quote", defaultCategory: "general", fieldMap: { "your-name": "name", input_3: "requestedService" } });
    const re = await createLeadSource(admin, { name: "Website – home valuation", defaultCategory: "real_estate" });

    const body = { "your-name": "Dana Lead", phone: "416-555-0142", input_3: "Sofa cleaning", city: "Mississauga", preferred_date: "2031-06-01", submission_id: "wp-1", "g-recaptcha-response": "xyz" };
    const r1 = await intake(svc.source.slug, svc.secret, body);
    expect(r1.status).toBe(201);
    const { data } = await r1.json();
    const lead = await getLead(admin, data.id);
    expect(lead).toMatchObject({ category: "general", channel: "intake", source: "Website – cleaning quote", name: "Dana Lead", phone: "+14165550142", city: "Mississauga", status: "new" });
    expect(lead.service).toEqual({ requestedService: "Sofa cleaning", preferredDate: "2031-06-01", serviceLocation: "" });
    expect(lead.notes).not.toContain("xyz");

    // The sending system retries: no duplicate.
    const r2 = await intake(svc.source.slug, svc.secret, body);
    expect(r2.status).toBe(200);
    expect((await r2.json()).data).toEqual({ id: data.id, duplicate: true });
    // Idempotency-Key header works too; identical bodies without any id are also deduplicated.
    const noId = { name: "Eli Lead", email: "eli@example.test" };
    expect((await intake(svc.source.slug, svc.secret, noId)).status).toBe(201);
    expect((await intake(svc.source.slug, svc.secret, noId)).status).toBe(200);
    expect((await intake(svc.source.slug, svc.secret, { ...noId, name: "Eli L" }, { headers: { "idempotency-key": "entry-77" } })).status).toBe(201);
    expect((await intake(svc.source.slug, svc.secret, { ...noId, name: "Eli L2" }, { headers: { "idempotency-key": "entry-77" } })).status).toBe(200);
    expect(await Lead.countDocuments({})).toBe(3);

    // Real estate source, URL-encoded form body.
    const r3 = await intake(re.source.slug, re.secret, { name: "Robin Buyer", email: "robin@example.test", intent: "I want to buy", area: "Port Credit", budget: "$750,000", listing: "https://example.test/listing/1" }, { form: true });
    expect(r3.status).toBe(201);
    const reLead = await getLead(admin, (await r3.json()).data.id);
    expect(reLead.category).toBe("real_estate");
    expect(reLead.realEstate).toEqual({ intent: "buyer", areaOfInterest: "Port Credit", budgetCents: 75_000_000, listingUrl: "https://example.test/listing/1" });

    // The two categories stay separate.
    expect((await listLeads(admin, { category: "real_estate", status: "open", page: 1 })).items.map((l) => l.name)).toEqual(["Robin Buyer"]);
    expect((await listLeads(admin, { category: "general", status: "open", page: 1 })).total).toBe(3);

    const sources = await listLeadSources(admin);
    expect(sources.find((s) => s.id === svc.source.id)?.receivedCount).toBe(3);
  });

  it("rejects bad keys, paused sources and incomplete submissions; logs never contain secrets; keys can be rotated", async () => {
    const { admin } = await opsWorld();
    const src = await createLeadSource(admin, { name: "Website form", defaultCategory: "general" });
    const ok = { name: "Fay Lead", phone: "416-555-0150", submission_id: "s1" };
    expect((await intake(src.source.slug, null, ok)).status).toBe(401);
    expect((await intake(src.source.slug, "rpk_wrong", ok)).status).toBe(401);
    expect((await intake("src_0000000000000000", src.secret, ok)).status).toBe(401);
    const bad = await intake(src.source.slug, src.secret, { name: "No Contact", submission_id: "s2" });
    expect(bad.status).toBe(422);
    expect(await Lead.countDocuments({})).toBe(0);
    const unsupported = await intakeRoute.POST(new Request(`http://localhost:3000/api/v1/intake/leads/${src.source.slug}`, { method: "POST", headers: { authorization: `Bearer ${src.secret}`, "content-type": "text/plain" }, body: "hi" }), { params: Promise.resolve({ slug: src.source.slug }) });
    expect(unsupported.status).toBe(415);

    const rotated = await rotateLeadSourceSecret(admin, src.source.id);
    expect((await intake(src.source.slug, src.secret, ok)).status).toBe(401);
    expect((await intake(src.source.slug, rotated.secret, ok)).status).toBe(201);

    await updateLeadSource(admin, src.source.id, { active: false });
    expect((await intake(src.source.slug, rotated.secret, { ...ok, submission_id: "s3" })).status).toBe(401);

    const logs = await leadSourceLogs(admin, src.source.id);
    expect(logs.map((l) => l.outcome)).toEqual(expect.arrayContaining(["unauthorized", "rejected", "accepted"]));
    const raw = JSON.stringify(await LeadSubmissionLog.find({}).lean());
    expect(raw).not.toContain(src.secret);
    expect(raw).not.toContain(rotated.secret);
    expect(raw).not.toContain("416-555-0150");
    expect(JSON.stringify(await listLeadSources(admin))).not.toContain(rotated.secret);
  });

  it("rate-limits each source", async () => {
    const { admin } = await opsWorld();
    const src = await createLeadSource(admin, { name: "Busy form", defaultCategory: "general" });
    INTAKE_LIMITS.perSource.limit = 2;
    expect((await intake(src.source.slug, src.secret, { name: "A", phone: "416-555-0161", submission_id: "a" })).status).toBe(201);
    expect((await intake(src.source.slug, src.secret, { name: "B", phone: "416-555-0162", submission_id: "b" })).status).toBe(201);
    const limited = await intake(src.source.slug, src.secret, { name: "C", phone: "416-555-0163", submission_id: "c" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("leads: manual entry, CSV, conversion", () => {
  it("converts safely: suggests the existing customer, never duplicates on retry, and keeps the lead's source and history", async () => {
    const { admin, sofa } = await opsWorld();
    const S = String(sofa._id);
    const existing = await customerIn(admin, "Mississauga", "Gail");
    const lead1 = await createLead(admin, { category: "general", name: "Gail Fixture", phone: "(514) 555-0199", source: "Referral", requestedService: "Sofa cleaning", preferredDate: "2031-07-01" });
    const matches = await conversionMatches(admin, lead1.id);
    expect(matches.find((m) => m.id === existing.customer.id)?.matchedOn).toEqual(expect.arrayContaining(["phone", "name"]));
    const conv = await convertLead(admin, lead1.id, { customerId: existing.customer.id });
    expect(conv).toEqual({ customerId: existing.customer.id, created: false });
    expect(await convertLead(admin, lead1.id, { customerId: existing.customer.id })).toEqual({ customerId: existing.customer.id, created: false });
    const after = await getLead(admin, lead1.id);
    expect(after).toMatchObject({ status: "converted", source: "Referral", channel: "manual", convertedCustomerId: existing.customer.id });
    expect(after.history.map((h) => h.kind)).toEqual(["converted", "created"]);

    // New customer: retried and concurrent requests create exactly one.
    const lead2 = await createLead(admin, { category: "real_estate", name: "Hana Seller", email: "hana@example.test", intent: "seller", areaOfInterest: "Streetsville" });
    const results = await Promise.all([convertLead(admin, lead2.id, { create: true }), convertLead(admin, lead2.id, { create: true })]);
    expect(new Set(results.map((r) => r.customerId)).size).toBe(1);
    expect(await convertLead(admin, lead2.id, { create: true })).toMatchObject({ customerId: results[0]!.customerId });
    expect(await Customer.countDocuments({ name: "Hana Seller" })).toBe(1);
    await expect(convertLead(admin, lead2.id, { customerId: existing.customer.id })).rejects.toMatchObject({ status: 409 });

    // A service lead can go straight on to a booking for that customer.
    const { booking } = await createBooking(admin, bookingBody({ customerId: existing.customer.id, addressId: existing.address.id, serviceId: S, date: "2031-07-01", startTime: "10:00" }));
    expect(booking.customer.id).toBe(existing.customer.id);
  });

  it("tracks status, assignment and notes, refuses manual 'converted', and imports CSV without duplicates", async () => {
    const { admin, org } = await opsWorld();
    const staffDoc = await createUser(org._id, { role: "STAFF", grants: ["leads:read", "leads:write"] });
    const lead = await createLead(admin, { category: "general", name: "Ivy Lead", phone: "416-555-0170" });
    const upd = await updateLead(admin, lead.id, { status: "contacted", assignedTo: String(staffDoc._id), note: "Called, wants a quote" });
    expect(upd.status).toBe("contacted");
    expect(upd.assignedTo?.id).toBe(String(staffDoc._id));
    expect(upd.history[0]!.text).toBe("Called, wants a quote");
    await expect(updateLead(admin, lead.id, { status: "converted" })).rejects.toThrow();
    await expect(createLead(admin, { category: "general", name: "No Contact" })).rejects.toThrow();

    const csv = "Name,Phone,Email,City,Intent,Area,Budget\nJo Buyer,416-555-0181,,Mississauga,buyer,Meadowvale,650000\nNo Contact,,,Toronto,,,\n";
    const preview = await importLeadsCsv(admin, { category: "real_estate", csv, commit: false });
    expect(preview).toMatchObject({ total: 2, valid: 1, duplicates: 0, created: 0 });
    expect(preview.invalid).toHaveLength(1);
    expect((await importLeadsCsv(admin, { category: "real_estate", csv, commit: true })).created).toBe(1);
    expect((await importLeadsCsv(admin, { category: "real_estate", csv, commit: true })).created).toBe(0);
    const jo = (await listLeads(admin, { category: "real_estate", status: "all", page: 1 })).items[0]!;
    expect(jo).toMatchObject({ name: "Jo Buyer", channel: "csv_import", summary: "Buyer · Meadowvale" });
  });
});

// ---------------------------------------------------------------------------
// Google Calendar (network mocked)
// ---------------------------------------------------------------------------

const GOOGLE = {
  GOOGLE_CLIENT_ID: "1234567890-test.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret-value",
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

type Call = { method: string; url: string; body: Record<string, unknown> | null };

function googleMock(handlers: { insert?: (body: Record<string, unknown>) => Response; token?: () => Response; list?: () => Response } = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : null;
    const body = raw && raw.startsWith("{") ? (JSON.parse(raw) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return handlers.token ? handlers.token() : json(200, { access_token: "at-test", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar.events" });
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json(200, {});
    if (url.includes("/events") && method === "POST") return handlers.insert ? handlers.insert(body!) : json(200, { id: body!.id });
    if (url.includes("/events/") && method === "PATCH") return json(200, { id: decodeURIComponent(url.split("/events/")[1]!.split("?")[0]!) });
    if (url.includes("/events/") && method === "DELETE") return new Response(null, { status: 204 });
    if (url.includes("/events?") && method === "GET") return handlers.list ? handlers.list() : json(200, { items: [] });
    return json(404, { error: { message: "unexpected" } });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

async function connect(orgId: Types.ObjectId, userId: Types.ObjectId, opts: { expired?: boolean } = {}) {
  await GoogleCalendarConnection.create({
    organizationId: orgId,
    connectedBy: userId,
    googleEmail: "office@example.test",
    refreshTokenEnc: encryptSecret("rt-test", GOOGLE.TOKEN_ENCRYPTION_KEY),
    accessTokenEnc: opts.expired ? null : encryptSecret("at-test", GOOGLE.TOKEN_ENCRYPTION_KEY),
    accessTokenExpiresAt: opts.expired ? null : new Date(Date.now() + 3600_000),
    calendarId: "cal-1",
    calendarName: "RealtyPacer bookings",
    status: "connected",
  });
}

describe("Google Calendar sync (mocked Google API)", () => {
  beforeEach(() => Object.assign(process.env, GOOGLE));
  afterEach(() => {
    for (const k of Object.keys(GOOGLE)) delete process.env[k];
    vi.unstubAllGlobals();
  });

  it("creates, updates and cancels the event without inviting anyone or exposing office notes", async () => {
    const { admin, adminDoc, org, sofa, ana } = await opsWorld();
    const S = String(sofa._id);
    const { customer, address } = await customerIn(admin, "Mississauga", "Kim");
    await connect(org._id, adminDoc._id);
    const calls = googleMock();

    const { booking } = await createBooking(admin, { ...bookingBody({ customerId: customer.id, addressId: address.id, serviceId: S, date: "2031-04-01", startTime: "09:00", cleanerIds: [String(ana._id)] }), officeNotes: "Gate code 4321 — internal" });
    expect(await processCalendarSyncBatch(10)).toEqual({ synced: 1, retried: 0, failed: 0 });
    const insert = calls.find((c) => c.method === "POST" && c.url.includes("/calendars/cal-1/events"))!;
    expect(insert.url).toContain("sendUpdates=none");
    expect(insert.body!.id).toBe(`rp${booking.id}`);
    expect(insert.body!.attendees).toBeUndefined();
    expect(insert.body!.summary).toBe("Sofa cleaning — Kim Fixture");
    expect(String(insert.body!.location)).toContain("Mississauga");
    expect(String(insert.body!.description)).toContain(`/dashboard/bookings/${booking.id}`);
    expect(String(insert.body!.description)).toContain("Ana Test");
    expect(JSON.stringify(insert.body)).not.toContain("4321");
    expect(JSON.stringify(insert.body)).not.toMatch(/\$|120\.00|12000/);
    expect((await CalendarSync.findOne({ bookingId: booking.id }).lean())).toMatchObject({ status: "synced", eventId: `rp${booking.id}`, calendarId: "cal-1" });

    const v2 = await updateBooking(admin, booking.id, { expectedVersion: booking.version, date: "2031-04-02", startTime: "10:00", durationMinutes: 60 });
    await processCalendarSyncBatch(10);
    const patch = calls.filter((c) => c.method === "PATCH").at(-1)!;
    expect(patch.url).toContain(`/events/rp${booking.id}?sendUpdates=none`);
    expect((patch.body!.start as { dateTime: string }).dateTime).toBe(new Date(v2.scheduledStartAt).toISOString());

    await transitionBooking(admin, booking.id, { action: "cancel", reason: "Customer cancelled", expectedVersion: v2.version });
    await processCalendarSyncBatch(10);
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes(`/events/rp${booking.id}?sendUpdates=none`))).toBe(true);
    expect((await CalendarSync.findOne({ bookingId: booking.id }).lean())?.status).toBe("removed");
    expect((await googleStatus(admin)).connection?.lastSyncAt).not.toBeNull();
  });

  it("treats an already-existing event (409) as an update, retries with backoff, and allows a manual retry", async () => {
    const { admin, adminDoc, org, sofa } = await opsWorld();
    const { customer, address } = await customerIn(admin, "Mississauga", "Lee");
    await connect(org._id, adminDoc._id);
    let mode: "conflict" | "error" | "ok" = "conflict";
    const calls = googleMock({
      insert: (b) => (mode === "conflict" ? new Response(JSON.stringify({ error: { code: 409, message: "The requested identifier already exists.", errors: [{ reason: "duplicate" }] } }), { status: 409 }) : mode === "error" ? new Response(JSON.stringify({ error: { code: 503, message: "Backend Error" } }), { status: 503 }) : new Response(JSON.stringify({ id: b.id }), { status: 200 })),
    });
    const { booking } = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: "2031-04-03", startTime: "09:00" }));
    await processCalendarSyncBatch(10);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect((await CalendarSync.findOne({ bookingId: booking.id }).lean())?.status).toBe("synced");
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/events")).length).toBe(1);

    const second = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: "2031-04-04", startTime: "09:00" }));
    mode = "error";
    const t0 = new Date();
    expect(await processCalendarSyncBatch(10, () => t0)).toMatchObject({ retried: 1 });
    const pending = (await CalendarSync.findOne({ bookingId: second.booking.id }).lean())!;
    expect(pending.status).toBe("pending");
    expect(pending.attempts).toBe(1);
    expect(pending.nextAttemptAt!.getTime() - t0.getTime()).toBe(30_000);
    expect(await processCalendarSyncBatch(10, () => t0)).toMatchObject({ synced: 0, retried: 0 }); // not due yet
    // Exhaust attempts → failed, then manual retry succeeds.
    for (let i = 1; i <= 6; i++) await processCalendarSyncBatch(10, () => new Date(t0.getTime() + i * 3 * 3600_000));
    expect((await CalendarSync.findOne({ bookingId: second.booking.id }).lean())?.status).toBe("failed");
    expect((await googleStatus(admin)).problems.map((p) => p.bookingId)).toContain(second.booking.id);
    mode = "ok";
    expect(await retryCalendarSync(admin, { bookingId: second.booking.id })).toEqual({ queued: 1 });
    await processCalendarSyncBatch(10);
    expect((await CalendarSync.findOne({ bookingId: second.booking.id }).lean())?.status).toBe("synced");
  });

  it("marks the connection for reconnecting when Google revokes the token and keeps pending changes", async () => {
    const { admin, adminDoc, org, sofa } = await opsWorld();
    const { customer, address } = await customerIn(admin, "Mississauga", "Max");
    await connect(org._id, adminDoc._id, { expired: true });
    googleMock({ token: () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 }) });
    const { booking } = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: "2031-04-05", startTime: "09:00" }));
    await processCalendarSyncBatch(10);
    const status = await googleStatus(admin);
    expect(status.connection?.status).toBe("needs_reauth");
    const job = (await CalendarSync.findOne({ bookingId: booking.id }).lean())!;
    expect(job.status).toBe("pending");
    expect(job.lastError).toMatch(/reconnected/);
  });

  it("encrypts tokens, uses single-use OAuth state bound to the user, and never syncs when not connected", async () => {
    const { admin, adminDoc, org, sofa } = await opsWorld();
    const enc = encryptSecret("refresh-token-value", GOOGLE.TOKEN_ENCRYPTION_KEY);
    expect(enc).not.toContain("refresh-token-value");
    expect(decryptSecret(enc, GOOGLE.TOKEN_ENCRYPTION_KEY)).toBe("refresh-token-value");
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), GOOGLE.TOKEN_ENCRYPTION_KEY)).toThrow();

    // Not connected yet: booking changes queue nothing.
    const { customer, address } = await customerIn(admin, "Mississauga", "Nia");
    const { booking } = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: addDaysToKey(localDateKey(new Date(), "America/Toronto"), 3), startTime: "09:00" }));
    await queueCalendarSync(org._id, booking.id, "upsert");
    expect(await CalendarSync.countDocuments({})).toBe(0);

    const idToken = `x.${Buffer.from(JSON.stringify({ email: "office@example.test" })).toString("base64url")}.y`;
    googleMock({ token: () => new Response(JSON.stringify({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600, scope: "openid email https://www.googleapis.com/auth/calendar.events", id_token: idToken }), { status: 200 }) });
    const { url } = await startGoogleConnect(admin);
    const u = new URL(url);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/v1/integrations/google/callback");
    const state = u.searchParams.get("state")!;
    const other = await actorFor(await createUser(org._id, { role: "ADMIN" }));
    await expect(completeGoogleConnect(other, "code", state)).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    await completeGoogleConnect(admin, "code", state);
    await expect(completeGoogleConnect(admin, "code", state)).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    expect(await OAuthState.countDocuments({})).toBe(0);
    const conn = (await GoogleCalendarConnection.findOne({ organizationId: org._id }).lean())!;
    expect(conn.googleEmail).toBe("office@example.test");
    expect(JSON.stringify(conn)).not.toContain("rt-new");
    expect(decryptSecret(conn.refreshTokenEnc!, GOOGLE.TOKEN_ENCRYPTION_KEY)).toBe("rt-new");
    // Upcoming bookings (next 90 days) are queued once connected.
    expect(await CalendarSync.countDocuments({ bookingId: booking.id, status: "pending" })).toBe(1);
    void adminDoc;
  });

  it("reports Google busy times (start/end only) and skips RealtyPacer's own events", async () => {
    const { admin, adminDoc, org } = await opsWorld();
    await connect(org._id, adminDoc._id);
    googleMock({
      list: () =>
        new Response(
          JSON.stringify({
            items: [
              { id: "e1", summary: "Dentist", start: { dateTime: "2031-04-07T14:00:00Z" }, end: { dateTime: "2031-04-07T15:00:00Z" } },
              { id: "rpabc", summary: "Sofa", start: { dateTime: "2031-04-07T16:00:00Z" }, end: { dateTime: "2031-04-07T17:00:00Z" }, extendedProperties: { private: { rpBookingId: "abc" } } },
              { id: "e3", summary: "Free", transparency: "transparent", start: { dateTime: "2031-04-07T18:00:00Z" }, end: { dateTime: "2031-04-07T19:00:00Z" } },
            ],
          }),
          { status: 200 },
        ),
    });
    const res = await googleBusy(admin, new Date("2031-04-07T04:00:00Z"), new Date("2031-04-08T04:00:00Z"));
    expect(res).toEqual({ connected: true, busy: [{ start: "2031-04-07T14:00:00Z", end: "2031-04-07T15:00:00Z" }] });
  });

  it("shows 'not configured' without credentials", async () => {
    for (const k of Object.keys(GOOGLE)) delete process.env[k];
    const { admin } = await opsWorld();
    const st = await googleStatus(admin);
    expect(st.configured).toBe(false);
    expect(st.connection).toBeNull();
    await expect(startGoogleConnect(admin)).rejects.toMatchObject({ code: "GOOGLE_NOT_CONFIGURED" });
  });
});

// ---------------------------------------------------------------------------
// Permissions and organization isolation
// ---------------------------------------------------------------------------

describe("permissions and organization isolation", () => {
  it("keeps cleaners and ungranted staff out of leads, integrations, the customer filter and financial columns", async () => {
    const { org } = await opsWorld();
    const cleaner = await actorFor(await createUser(org._id, { role: "CLEANER" }));
    const staff = await actorFor(await createUser(org._id, { role: "STAFF" }));
    const granted = await actorFor(await createUser(org._id, { role: "STAFF", grants: ["leads:read", "leads:write", "integrations:manage", "reports:read"] }));
    for (const u of [cleaner, staff]) {
      await expect(listLeads(u, { category: "general", status: "open", page: 1 })).rejects.toMatchObject({ status: 403 });
      await expect(createLead(u, { category: "general", name: "X", phone: "416-555-0100" })).rejects.toMatchObject({ status: 403 });
      await expect(listLeadSources(u)).rejects.toMatchObject({ status: 403 });
      await expect(googleStatus(u)).rejects.toMatchObject({ status: 403 });
      await expect(runCustomerFilter(u, { conditions: [] })).rejects.toMatchObject({ status: 403 });
    }
    // Staff can be granted leads, but never integration credentials.
    expect((await listLeads(granted, { category: "general", status: "open", page: 1 })).total).toBe(0);
    await expect(listLeadSources(granted)).rejects.toMatchObject({ status: 403 });
    await expect(googleStatus(granted)).rejects.toMatchObject({ status: 403 });
    // Reports without financial access: totals without money.
    expect((await runCustomerFilter(granted, { conditions: [] })).totals.paidCents).toBeNull();
  });

  it("isolates leads, sources, filters and calendar data per organization", async () => {
    const one = await clientWorld();
    const lead = await createLead(one.admin, { category: "general", name: "Org One Lead", phone: "416-555-0190" });
    const src = await createLeadSource(one.admin, { name: "Org one form", defaultCategory: "general" });
    const org2 = await createOrg("Other Co");
    const admin2 = await actorFor(await createUser(org2._id, { role: "ADMIN" }));
    await expect(getLead(admin2, lead.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateLead(admin2, lead.id, { note: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(convertLead(admin2, lead.id, { create: true })).rejects.toMatchObject({ status: 404 });
    await expect(updateLeadSource(admin2, src.source.id, { active: false })).rejects.toMatchObject({ status: 404 });
    expect(await listLeadSources(admin2)).toEqual([]);
    expect((await runCustomerFilter(admin2, { conditions: [] })).totals).toMatchObject({ customers: 0, services: 0 });
    // Linking another organization's customer is refused.
    const lead2 = await createLead(admin2, { category: "general", name: "Org Two Lead", phone: "416-555-0191" });
    await expect(convertLead(admin2, lead2.id, { customerId: one.alice.customer.id })).rejects.toMatchObject({ status: 404 });
    // Intake through org one's source lands only in org one.
    expect((await intake(src.source.slug, src.secret, { name: "Web Lead", phone: "416-555-0192", submission_id: "w1" })).status).toBe(201);
    expect((await listLeads(admin2, { category: "general", status: "all", page: 1 })).items.map((l) => l.name)).toEqual(["Org Two Lead"]);
    expect(await googleStatus(admin2)).toMatchObject({ connection: null, problems: [] });
    void key;
  });
});
