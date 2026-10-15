import { describe, expect, it, vi } from "vitest";
import { Customer } from "@/lib/db/models/customer";
import { reportDefinitionSchema, encodeDefinition } from "@/modules/reports/definition";
import { compileCondition, compileFilters, fieldRegistry } from "@/modules/reports/filters";
import { csvCell, exportReportCsv } from "@/modules/reports/csv";
import { runReport } from "@/modules/reports/engine";
import { createView, listViews, updateView } from "@/modules/reports/views";
import { createDefinition, updateDefinition } from "@/modules/custom-fields/service";
import { createCustomer, getCustomer, listCustomers, updateCustomer } from "@/modules/customers/service";
import { createBooking, getBooking } from "@/modules/bookings/service";
import { linkCleanerUser } from "@/modules/cleaners/service";
import { recordPayment } from "@/modules/finance/payments";
import * as paymentsRoute from "@/app/api/v1/payments/route";
import * as exportRoute from "@/app/api/v1/reports/export/route";
import { createUser, ctx, jsonRequest, signInAs } from "./helpers/fixtures";
import { actorFor, opsWorld } from "./helpers/ops-fixtures";
import { customerIn, finalizedBooking, key, pay } from "./helpers/finance-fixtures";

vi.mock("@/lib/auth/claims", () => ({ getSessionClaims: vi.fn() }));

const baseDef = { mode: "service" as const, datePreset: "custom" as const, from: "2026-06-01", to: "2026-06-30", statuses: ["COMPLETED" as const], filters: { logic: "and" as const, conditions: [] as never[] } };

describe("custom fields", () => {
  it("generates safe keys, validates values, rejects undeclared fields and enforces required on create", async () => {
    const { admin } = await opsWorld();
    const num = await createDefinition(admin, { entityType: "customer", label: "Number of pets", dataType: "number", validation: { min: 0, max: 20, integer: true }, filterable: true, showInTable: true });
    expect(num.key).toMatch(/^cf_[a-z0-9]{8}$/);
    const pick = await createDefinition(admin, { entityType: "customer", label: "Preferred day", dataType: "single_select", options: [{ label: "Monday" }, { label: "Friday" }], filterable: true });
    const monday = pick.options[0]!.value;
    await expect(createDefinition(admin, { entityType: "customer", label: "Notes", dataType: "long_text", filterable: true })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createDefinition(admin, { entityType: "customer", label: "x", dataType: "short_text", key: "$where" } as never)).rejects.toThrow();

    const c = await createCustomer(admin, { firstName: "Cf", lastName: "Test", phone: "4165550100", confirmDuplicate: true, customFields: { [num.key]: 2, [pick.key]: monday } });
    expect((await getCustomer(admin, c.id)).customFields).toEqual({ [num.key]: 2, [pick.key]: monday });
    await expect(createCustomer(admin, { firstName: "Bad", phone: "4165550101", confirmDuplicate: true, customFields: { [num.key]: 2.5 } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createCustomer(admin, { firstName: "Bad", phone: "4165550102", confirmDuplicate: true, customFields: { cf_notexist: 1 } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(createCustomer(admin, { firstName: "Bad", phone: "4165550103", confirmDuplicate: true, customFields: { "address.city": "x" } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // New required field: old records stay valid; new records must supply it.
    const req = await createDefinition(admin, { entityType: "customer", label: "Gate code", dataType: "short_text", required: true, filterable: true });
    await expect(createCustomer(admin, { firstName: "New", phone: "4165550104", confirmDuplicate: true })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const list = await listCustomers(admin, { page: 1, pageSize: 10, status: "active", sort: "name", dir: "asc", f: encodeDefinition([{ field: `cf:customer:${req.key}`, op: "empty" }]) });
    expect(list.items.map((x) => x.id)).toEqual([c.id]); // "missing value" filter finds records to fix

    // Type change is blocked while values exist; rename keeps data; archive keeps values but hides them.
    await expect(updateDefinition(admin, num.id, { dataType: "short_text" })).rejects.toMatchObject({ code: "TYPE_CHANGE_BLOCKED" });
    await updateDefinition(admin, num.id, { label: "Pets" });
    await updateDefinition(admin, num.id, { archived: true });
    expect((await getCustomer(admin, c.id)).customFields).toEqual({ [pick.key]: monday });
    expect(((await Customer.findById(c.id).lean())!.customFields as Record<string, unknown>)[num.key]).toBe(2);
    await expect(updateCustomer(admin, c.id, { firstName: "Cf", lastName: "Test", phone: "4165550100", customFields: { [num.key]: 3 } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(updateDefinition(admin, pick.id, { options: [{ value: monday, label: "Mon" }] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" }); // can't delete Friday
  });

  it("never sends office-only booking fields to cleaners", async () => {
    const { admin, sofa, ana, org } = await opsWorld();
    const office = await createDefinition(admin, { entityType: "booking", label: "Internal margin note", dataType: "short_text", visibility: "office" });
    const shared = await createDefinition(admin, { entityType: "booking", label: "Pet in house", dataType: "boolean", visibility: "assigned_cleaners" });
    const c = await customerIn(admin, "Toronto", "Vis");
    const { booking } = await createBooking(admin, { idempotencyKey: key(), customerId: c.customer.id, addressId: c.address.id, date: "2031-01-10", startTime: "10:00", durationMinutes: 60, lineItems: [{ serviceId: String(sofa._id), quantity: 1 }], cleanerIds: [String(ana._id)], customFields: { [office.key]: "secret", [shared.key]: true } });
    const cleanerUser = await createUser(org._id, { role: "CLEANER" });
    await linkCleanerUser(admin, String(ana._id), String(cleanerUser._id));
    const view = await getBooking(await actorFor(cleanerUser), booking.id);
    expect(view.customFields).toEqual({ [shared.key]: true });
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(view.billing).toBeNull();
  });
});

describe("filters, saved views and exports", () => {
  it("rejects unsafe operators, unknown fields and operator-shaped values", async () => {
    const { admin } = await opsWorld();
    expect(reportDefinitionSchema.safeParse({ ...baseDef, filters: { logic: "and", conditions: [{ field: "city", op: "$where", value: "1" }] } }).success).toBe(false);
    expect(reportDefinitionSchema.safeParse({ ...baseDef, filters: { logic: "or", conditions: [] } }).success).toBe(false);
    expect(reportDefinitionSchema.safeParse({ ...baseDef, filters: { logic: "and", conditions: [{ field: "$ne", op: "eq", value: 1 }] } }).success).toBe(false);
    const specs = await fieldRegistry(admin, "service");
    expect(() => compileFilters(specs, [{ field: "organizationId", op: "eq", value: "x" }])).toThrow();
    const city = specs.find((s) => s.key === "city")!;
    expect(() => compileCondition(city, "any_of", [{ $gt: "" }])).toThrow();
    expect(() => compileCondition(city, "gt", "a")).toThrow(); // operator not allowed for this field
    expect(compileCondition(city, "any_of", ["  Mississauga "])).toEqual({ "addressSnapshot.cityNormalized": { $in: ["mississauga"] } });
    const name = (await fieldRegistry(admin, "customers")).find((s) => s.key === "customerName")!;
    expect(compileCondition(name, "contains", "a.*(")).toEqual({ "cust.searchName": { $regex: "a\\.\\*\\(", $options: "i" } });
  });

  it("keeps private views private, restricts sharing, and degrades gracefully on archived fields", async () => {
    const { admin, org } = await opsWorld();
    const staff = await actorFor(await createUser(org._id, { role: "STAFF", grants: ["reports:read"] }));
    const cf = await createDefinition(admin, { entityType: "booking", label: "Crew", dataType: "short_text", filterable: true });
    const mine = await createView(admin, { name: "Private", definition: { ...baseDef, filters: { logic: "and", conditions: [{ field: `cf:booking:${cf.key}`, op: "contains", value: "A" }] } } });
    expect((await listViews(staff)).map((v) => v.id)).not.toContain(mine.id);
    await expect(createView(staff, { name: "Team", visibility: "shared", definition: baseDef })).rejects.toMatchObject({ status: 403 });
    await updateView(admin, mine.id, { visibility: "shared" });
    expect((await listViews(staff)).map((v) => v.id)).toContain(mine.id);
    await expect(updateView(staff, mine.id, { name: "Hijack" })).rejects.toMatchObject({ status: 403 });
    await updateDefinition(admin, cf.id, { archived: true });
    const view = (await listViews(admin)).find((v) => v.id === mine.id)!;
    const r = await runReport(admin, view.definition, { lenient: true });
    expect(r.warnings.join(" ")).toMatch(/archived/);
    // A view never grants access: staff without financials sees no money even in a shared view.
    const sr = await runReport(staff, view.definition, { lenient: true });
    expect(sr.moneyVisible).toBe(false);
    expect(sr.totals.chargedCents).toBeNull();
  });

  it("exports full filtered results with formula protection and no unauthorized columns", async () => {
    const { admin, sofa, org } = await opsWorld();
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell(-250)).toBe("-250");
    const c = await createCustomer(admin, { customerType: "business", displayName: "=cmd|' /C calc'!A0", phone: "4165550188", confirmDuplicate: true, primaryAddress: { label: "", line1: "1 A St", city: "Mississauga" } });
    const addr = (await (await import("@/modules/customers/addresses")).listAddresses(admin, c.id))[0]!;
    for (let i = 0; i < 3; i++) await finalizedBooking(admin, { customer: { id: c.id }, address: { id: addr.id } }, [{ serviceId: String(sofa._id), unitPriceCents: 1000 + i }], { date: `2026-06-1${i}` });
    const csv = await exportReportCsv(admin, baseDef);
    expect(csv.rows).toBe(3);
    expect(csv.body.startsWith("﻿RealtyPacer export")).toBe(true);
    expect(csv.body).toContain("America/Toronto");
    expect(csv.body).toContain("'=cmd");
    expect(csv.body).not.toMatch(/,=cmd/);
    expect(csv.body).toContain("10.00,");
    const staff = await actorFor(await createUser(org._id, { role: "STAFF", grants: ["reports:read", "reports:export"] }));
    const staffCsv = await exportReportCsv(staff, baseDef);
    expect(staffCsv.body).not.toContain("Charged");
    expect(staffCsv.body).not.toContain("10.00");
    expect(staffCsv.body).not.toMatch(/passwordHash|officeNotes|sessionVersion/);
  });
});

describe("cleaners and unauthorized roles", () => {
  it("denies financial APIs, reports and exports to cleaners", async () => {
    const { admin, sofa, org } = await opsWorld();
    const c = await customerIn(admin, "Toronto", "Deny");
    const b = await finalizedBooking(admin, c, [{ serviceId: String(sofa._id), unitPriceCents: 1000 }]);
    await pay(admin, c.customer.id, 500, [{ bookingId: b.id, lineItemId: b.lineFor(String(sofa._id)), amountCents: 500 }]);
    const cleanerDoc = await createUser(org._id, { role: "CLEANER" });
    const cleaner = await actorFor(cleanerDoc);
    await expect(recordPayment(cleaner, { idempotencyKey: key(), customerId: c.customer.id, amountCents: 100, receivedDate: "2026-06-11", receivedTime: "12:00", method: "cash" })).rejects.toMatchObject({ status: 403 });
    await expect(runReport(cleaner, baseDef)).rejects.toMatchObject({ status: 403 });
    await expect(exportReportCsv(cleaner, baseDef)).rejects.toMatchObject({ status: 403 });
    await signInAs(cleanerDoc);
    expect((await paymentsRoute.GET(jsonRequest("/api/v1/payments", "GET"), ctx({}))).status).toBe(403);
    expect((await exportRoute.POST(jsonRequest("/api/v1/reports/export", "POST", { definition: baseDef }), ctx({}))).status).toBe(403);
  });
});
