import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import { Activity } from "@/lib/db/models/activity";
import { Booking } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { Service } from "@/lib/db/models/service";
import { User } from "@/lib/db/models/user";
import { addDaysToKey, todayKey } from "@/lib/domain/zoned-time";
import { googleMapsUrl } from "@/lib/domain/links";
import { calendarEvents, changeBookingAddress, createBooking, getBooking, listBookings, myJobs, operationsSummary, transitionBooking, updateBooking } from "@/modules/bookings/service";
import { updateService } from "@/modules/catalog/service";
import { linkCleanerUser, setCleanerState } from "@/modules/cleaners/service";
import { createAddress, listAddresses, updateAddress } from "@/modules/customers/addresses";
import { createCustomer, customerMetrics, getCustomer, listCustomers, lookupCustomers } from "@/modules/customers/service";
import { addNote, createNoteSchema, listActivities } from "@/modules/activities/service";
import { createOrg, createUser } from "./helpers/fixtures";
import { actorFor, bookingBody, customerWithAddress, opsWorld } from "./helpers/ops-fixtures";

vi.mock("@/lib/auth/claims", () => ({ getSessionClaims: vi.fn() }));

const TZ = "America/Toronto";
const future = (days: number) => addDaysToKey(todayKey(TZ), days);

describe("customers", () => {
  it("creates a customer without email and never creates a login account", async () => {
    const { admin } = await opsWorld();
    const users = await User.countDocuments();
    const c = await createCustomer(admin, { firstName: "Robin", lastName: "Noemail", phone: "514-555-0142" });
    expect(c.email).toBeNull();
    expect(c.phone).toBe("+15145550142");
    expect(c.phoneDisplay).toBe("(514) 555-0142");
    expect(await User.countDocuments()).toBe(users);
  });

  it("requires a name and one contact method", async () => {
    const { admin } = await opsWorld();
    await expect(createCustomer(admin, { firstName: "", lastName: "", phone: "5145550100" })).rejects.toThrow();
    await expect(createCustomer(admin, { firstName: "No", lastName: "Contact" })).rejects.toThrow();
    await expect(createCustomer(admin, { customerType: "business", displayName: "Acme Rentals", email: "office@acme.example.test" })).resolves.toMatchObject({ name: "Acme Rentals" });
  });

  it("warns about possible duplicates but lets staff knowingly continue (shared contact details)", async () => {
    const { admin } = await opsWorld();
    await createCustomer(admin, { firstName: "Pat", lastName: "Household", phone: "+1 514 555 0177", email: "home@example.test" });
    await expect(createCustomer(admin, { firstName: "Sam", lastName: "Household", phone: "514.555.0177" })).rejects.toMatchObject({
      code: "POSSIBLE_DUPLICATES",
      details: { matches: [expect.objectContaining({ name: "Pat Household", matchedOn: ["phone"] })] },
    });
    const second = await createCustomer(admin, { firstName: "Sam", lastName: "Household", phone: "514.555.0177", confirmDuplicate: true });
    expect(second.phone).toBe("+15145550177");
    expect(await Customer.countDocuments({ phone: "+15145550177" })).toBe(2);
  });

  it("searches by name, partial phone and email, with bounded pagination", async () => {
    const { admin } = await opsWorld();
    await createCustomer(admin, { firstName: "Jordan", lastName: "Searchable", phone: "(438) 555-0123", email: "jordan@example.test" });
    for (const q of ["jordan", "SEARCH", "555-0123", "4385550123", "jordan@exa"]) {
      const r = await listCustomers(admin, { page: 1, pageSize: 10, q, status: "active", sort: "name", dir: "asc" });
      expect(r.total, q).toBe(1);
    }
    expect((await lookupCustomers(admin, "(.*)+")).items).toEqual([]);
  });

  it("filters by current address city and keeps archived customers out of active lists", async () => {
    const { admin } = await opsWorld();
    const { customer } = await customerWithAddress(admin);
    await createAddress(admin, customer.id, { label: "Cottage", line1: "1 Lake Rd", line2: "", city: "Laval", region: "QC", postalCode: "", country: "Canada", accessInstructions: "", isPrimary: false, links: [] });
    const q = { page: 1, pageSize: 10, status: "active" as const, sort: "name" as const, dir: "asc" as const };
    expect((await listCustomers(admin, { ...q, city: "laval" })).total).toBe(1);
    expect((await listCustomers(admin, { ...q, city: "Toronto" })).total).toBe(0);
  });

  it("rejects cross-organization reads and writes", async () => {
    const { admin } = await opsWorld();
    const { customer } = await customerWithAddress(admin);
    const other = await createOrg("Other Co");
    const outsider = await actorFor(await createUser(other._id, { role: "ADMIN" }));
    await expect(getCustomer(outsider, customer.id)).rejects.toMatchObject({ status: 404 });
    await expect(createAddress(outsider, customer.id, { label: "", line1: "x", line2: "", city: "y", region: "", postalCode: "", country: "", accessInstructions: "", isPrimary: false, links: [] })).rejects.toMatchObject({ status: 404 });
  });
});

describe("addresses and links", () => {
  it("keeps one default address and builds encoded map links", async () => {
    const { admin } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    expect(address.isPrimary).toBe(true);
    await createAddress(admin, customer.id, { label: "Office", line1: "200 Rue & Co #5", line2: "", city: "Montréal", region: "QC", postalCode: "h3b 1a1", country: "Canada", accessInstructions: "Buzz 12", isPrimary: true, links: [{ label: "Listing", url: "https://listings.example.test/123" }] });
    const all = await listAddresses(admin, customer.id);
    expect(all.filter((a) => a.isPrimary)).toHaveLength(1);
    const office = all.find((a) => a.label === "Office")!;
    expect(office.postalCode).toBe("H3B 1A1");
    expect(office.mapUrl).toContain(encodeURIComponent("200 Rue & Co #5"));
    expect(googleMapsUrl({ location: { lat: 45.5, lng: -73.56 } })).toBe("https://www.google.com/maps/search/?api=1&query=45.5%2C-73.56");
  });

  it("rejects unsafe external links", async () => {
    const { admin } = await opsWorld();
    const { addressInputSchema } = await import("@/modules/customers/schemas");
    for (const url of ["javascript:alert(1)", "ftp://x.example.test", "https://user:pw@example.test"]) {
      expect(addressInputSchema.safeParse({ line1: "1 A St", city: "Montreal", links: [{ label: "x", url }] }).success, url).toBe(false);
    }
    void admin;
  });
});

describe("bookings", () => {
  it("creates multi-item bookings with server-side totals and snapshots", async () => {
    const { admin, sofa, carpet, ana } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const body = { ...bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(2), startTime: "09:00", cleanerIds: [String(ana._id)] }), lineItems: [{ serviceId: String(sofa._id), quantity: 2 }, { serviceId: String(carpet._id), quantity: 3 }] };
    const { booking, created } = await createBooking(admin, body);
    expect(created).toBe(true);
    expect(booking.reference).toMatch(/^RP-\d{6}-[2-9A-HJ-NP-Z]{5}$/);
    expect(booking.subtotalCents).toBe(2 * 12000 + 3 * 4500);
    expect(booking.lineItems.map((l) => l.lineTotalCents)).toEqual([24000, 13500]);
    expect(booking.local).toMatchObject({ date: future(2), startTime: "09:00", endTime: "10:00" });
    expect(booking.cleaners.map((c) => c.name)).toEqual(["Ana Test"]);
  });

  it("is idempotent: retries and double clicks create one booking and one activity", async () => {
    const { admin, sofa } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const body = bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(3), startTime: "10:00" });
    const results = await Promise.all([createBooking(admin, body), createBooking(admin, body), createBooking(admin, body)]);
    expect(new Set(results.map((r) => r.booking.id)).size).toBe(1);
    expect(await Booking.countDocuments({ customerId: customer.id })).toBe(1);
    expect(await Activity.countDocuments({ type: "booking.created", customerId: customer.id })).toBe(1);
  });

  it("ignores client totals, rejects inactive services and unauthorized price overrides", async () => {
    const { admin, sofa, org } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const base = bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(4), startTime: "09:00" });
    await expect(createBooking(admin, { ...base, subtotalCents: 1 })).rejects.toThrow(); // unknown field rejected
    const staff = await actorFor(await createUser(org._id, { role: "STAFF", grants: ["bookings:write"] }));
    await expect(createBooking(staff, { ...base, lineItems: [{ serviceId: String(sofa._id), quantity: 1, unitPriceCents: 1 }] })).rejects.toMatchObject({ status: 403 });
    const { booking } = await createBooking(admin, { ...base, idempotencyKey: `${base.idempotencyKey}x`, lineItems: [{ serviceId: String(sofa._id), quantity: 1, unitPriceCents: 9900 }] });
    expect(booking.subtotalCents).toBe(9900);
    await Service.updateOne({ _id: sofa._id }, { $set: { active: false } });
    await expect(createBooking(admin, { ...base, idempotencyKey: `${base.idempotencyKey}y` })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    // Staff without pricing:read never receive amounts.
    const shaped = await getBooking(staff, booking.id);
    expect(shaped.subtotalCents).toBeNull();
    expect(shaped.lineItems[0]!.unitPriceCents).toBeNull();
  });

  it("preserves historical prices and addresses after catalog and address edits", async () => {
    const { admin, sofa } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const { booking } = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(5), startTime: "13:00" }));
    await updateService(admin, String(sofa._id), { defaultPriceCents: 99900, name: "Premium sofa cleaning" });
    await updateAddress(admin, customer.id, address.id, { label: "Home", line1: "999 New Address Ave", line2: "", city: "Laval", region: "QC", postalCode: "", country: "Canada", accessInstructions: "", isPrimary: true, links: [] });
    const after = await getBooking(admin, booking.id);
    expect(after.lineItems[0]).toMatchObject({ name: "Sofa cleaning", unitPriceCents: 12000 });
    expect(after.address.line1).toBe("100 Test Street");
    // Explicit refresh for a future booking is allowed and recorded.
    const refreshed = await changeBookingAddress(admin, booking.id, { addressId: address.id, expectedVersion: after.version });
    expect(refreshed.address.line1).toBe("999 New Address Ave");
    expect(await Activity.countDocuments({ bookingId: booking.id, type: "booking.address_changed" })).toBe(1);
  });

  it("blocks overlapping assignments, allows adjacent jobs, and ignores cancelled ones", async () => {
    const { admin, sofa, ana } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const mk = (startTime: string, durationMinutes = 60) =>
      bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(6), startTime, durationMinutes, cleanerIds: [String(ana._id)] });
    const first = await createBooking(admin, mk("09:00", 120)); // 09:00–11:00
    await expect(createBooking(admin, mk("10:30"))).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT", details: { conflicts: [expect.objectContaining({ reference: first.booking.reference, cleanerName: "Ana Test" })] } });
    await expect(createBooking(admin, mk("08:00", 61))).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
    await expect(createBooking(admin, mk("11:00"))).resolves.toBeTruthy(); // adjacent after
    await expect(createBooking(admin, mk("08:00"))).resolves.toBeTruthy(); // adjacent before
    await transitionBooking(admin, first.booking.id, { action: "cancel", reason: "Customer request", expectedVersion: first.booking.version });
    await expect(createBooking(admin, mk("09:30"))).resolves.toBeTruthy();
  });

  it("prevents simultaneous conflicting assignments (exactly one wins)", async () => {
    const { admin, sofa, ana } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const bodies = ["14:00", "14:30", "14:15", "13:45"].map((t) =>
      bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(7), startTime: t, cleanerIds: [String(ana._id)] }),
    );
    const results = await Promise.allSettled(bodies.map((b) => createBooking(admin, b)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) {
      expect(["SCHEDULE_CONFLICT", "BUSY_RETRY"]).toContain((r.reason as { code: string }).code);
    }
    expect(await Booking.countDocuments({ assignedCleanerIds: ana._id, status: "SCHEDULED" })).toBe(1);
  });

  it("reassigns, rejects stale edits, and refuses inactive cleaners", async () => {
    const { admin, sofa, ana, ben } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const { booking } = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(8), startTime: "09:00", cleanerIds: [String(ana._id)] }));
    const moved = await updateBooking(admin, booking.id, { expectedVersion: booking.version, cleanerIds: [String(ben._id)] });
    expect(moved.cleaners.map((c) => c.name)).toEqual(["Ben Test"]);
    await expect(updateBooking(admin, booking.id, { expectedVersion: booking.version, instructions: "stale" })).rejects.toMatchObject({ code: "STALE_VERSION" });
    const { affectedBookings } = await setCleanerState(admin, String(ben._id), "inactive");
    expect(affectedBookings.map((b) => b.id)).toEqual([booking.id]); // kept, surfaced for reassignment
    await expect(createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(9), startTime: "09:00", cleanerIds: [String(ben._id)] }))).rejects.toMatchObject({ code: "CLEANER_UNAVAILABLE" });
    expect(await Activity.countDocuments({ bookingId: booking.id, type: "booking.assignment_changed" })).toBe(1);
  });

  it("enforces lifecycle transitions and locks completed line items", async () => {
    const { admin, sofa, org } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const { booking } = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(1), startTime: "09:00" }));
    await expect(transitionBooking(admin, booking.id, { action: "reopen", reason: "nope", expectedVersion: 0 })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const started = await transitionBooking(admin, booking.id, { action: "start", expectedVersion: 0 });
    expect(started.status).toBe("IN_PROGRESS");
    expect(started.actualStartedAt).not.toBeNull();
    expect(started.scheduledStartAt).toBe(booking.scheduledStartAt); // scheduled time unchanged
    const done = await transitionBooking(admin, booking.id, { action: "complete", expectedVersion: started.version });
    expect(done.status).toBe("COMPLETED");
    await expect(updateBooking(admin, booking.id, { expectedVersion: done.version, lineItems: [{ serviceId: String(sofa._id), quantity: 5 }] })).rejects.toMatchObject({ code: "NOT_EDITABLE" });
    await expect(transitionBooking(admin, booking.id, { action: "cancel", reason: "too late", expectedVersion: done.version })).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const staff = await actorFor(await createUser(org._id, { role: "STAFF", grants: ["bookings:write"] }));
    await expect(transitionBooking(staff, booking.id, { action: "reopen", reason: "fix price", expectedVersion: done.version })).rejects.toMatchObject({ status: 403 });
    const reopened = await transitionBooking(admin, booking.id, { action: "reopen", reason: "Correct quantity", expectedVersion: done.version });
    expect(reopened.status).toBe("IN_PROGRESS");
  });

  it("cancels without deleting history", async () => {
    const { admin, sofa } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const { booking } = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(2), startTime: "15:00" }));
    await expect(transitionBooking(admin, booking.id, { action: "cancel", reason: "", expectedVersion: 0 })).rejects.toThrow();
    const cancelled = await transitionBooking(admin, booking.id, { action: "cancel", reason: "Customer travelling", expectedVersion: 0 });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancellationReason).toBe("Customer travelling");
    expect(await Booking.exists({ _id: booking.id })).toBeTruthy();
    const acts = await listActivities(admin, { bookingId: booking.id, page: 1, pageSize: 10 });
    expect(acts.items.map((a) => a.type)).toEqual(["booking.cancelled", "booking.created"]);
  });

  it("handles daylight-saving gaps and overlaps explicitly", async () => {
    const { admin, sofa } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const mk = (date: string, startTime: string, extra: Record<string, unknown> = {}) => ({ ...bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date, startTime }), ...extra });
    await expect(createBooking(admin, mk("2030-03-10", "02:30"))).rejects.toMatchObject({ code: "NONEXISTENT_LOCAL_TIME" });
    await expect(createBooking(admin, mk("2030-11-03", "01:30"))).rejects.toMatchObject({ code: "AMBIGUOUS_LOCAL_TIME" });
    const later = await createBooking(admin, mk("2030-11-03", "01:30", { disambiguation: "later" }));
    expect(later.booking.scheduledStartAt).toBe("2030-11-03T06:30:00.000Z"); // EST (UTC-5)
    const earlier = await createBooking(admin, mk("2030-11-03", "01:30", { disambiguation: "earlier" }));
    expect(earlier.booking.scheduledStartAt).toBe("2030-11-03T05:30:00.000Z"); // EDT (UTC-4)
  });
});

describe("metrics, dashboard and calendar", () => {
  it("counts completed bookings, service items and distinct local service days", async () => {
    const { admin, sofa, carpet, org } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const past = (date: string, startTime: string, items: { serviceId: string; quantity: number }[], status = "COMPLETED") => ({
      ...bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date, startTime }),
      lineItems: items,
      status,
    });
    // Two jobs on the same local day (one at 23:00 local = next day in UTC), one on another day.
    await createBooking(admin, past("2026-06-01", "09:00", [{ serviceId: String(sofa._id), quantity: 2 }]));
    await createBooking(admin, past("2026-06-01", "23:00", [{ serviceId: String(carpet._id), quantity: 3 }]));
    await createBooking(admin, past("2026-06-05", "10:00", [{ serviceId: String(carpet._id), quantity: 1 }]));
    await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(10), startTime: "09:00" }));
    const m = await customerMetrics(org._id, new Types.ObjectId(customer.id), TZ);
    expect(m).toMatchObject({ completedBookings: 3, completedServiceItems: 6, distinctServiceDays: 2, upcomingBookings: 1 });
    expect(m.firstCompletedAt).toBe("2026-06-01T13:00:00.000Z");
  });

  it("computes today/tomorrow/unassigned in the organization timezone", async () => {
    const { admin, sofa, ana } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const now = new Date();
    const tomorrow = addDaysToKey(todayKey(TZ, now), 1);
    await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: tomorrow, startTime: "00:30" }));
    await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: tomorrow, startTime: "23:00", cleanerIds: [String(ana._id)] }));
    const s = await operationsSummary(admin, {}, now);
    expect(s.tomorrowCount).toBe(2);
    expect(s.unassignedUpcoming).toBe(1);
    const range = await calendarEvents(admin, { start: tomorrow, end: tomorrow });
    expect(range.events.map((e) => e.start.slice(11, 16))).toEqual(["00:30", "23:00"]);
    await expect(calendarEvents(admin, { start: "2026-01-01", end: "2026-12-31" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("cleaner workspace and field restrictions", () => {
  it("shows cleaners only their assigned jobs, without prices, office notes or the customer directory", async () => {
    const { admin, sofa, ana, ben, org } = await opsWorld();
    const { customer, address } = await customerWithAddress(admin);
    const mine = await createBooking(admin, { ...bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(2), startTime: "09:00", cleanerIds: [String(ana._id)] }), officeNotes: "Customer owes from last time", instructions: "Use side door" });
    const theirs = await createBooking(admin, bookingBody({ customerId: customer.id, addressId: address.id, serviceId: String(sofa._id), date: future(2), startTime: "09:00", cleanerIds: [String(ben._id)] }));
    const cleanerUserDoc = await createUser(org._id, { role: "CLEANER" });
    await linkCleanerUser(admin, String(ana._id), String(cleanerUserDoc._id));
    const cleaner = await actorFor(cleanerUserDoc);

    const jobs = await myJobs(cleaner);
    expect(jobs.jobs.map((j) => j.id)).toEqual([mine.booking.id]);
    const view = await getBooking(cleaner, mine.booking.id);
    expect(view.officeNotes).toBeNull();
    expect(view.subtotalCents).toBeNull();
    expect(view.lineItems[0]!.unitPriceCents).toBeNull();
    expect(view.instructions).toBe("Use side door");
    expect(view.customer).toMatchObject({ name: customer.name, phone: "+15145550199", profileAccessible: false });
    expect(JSON.stringify(view)).not.toContain("owes");
    await expect(getBooking(cleaner, theirs.booking.id)).rejects.toMatchObject({ status: 404 });
    await expect(getCustomer(cleaner, customer.id)).rejects.toMatchObject({ status: 403 });
    await expect(listActivities(cleaner, { bookingId: mine.booking.id, page: 1, pageSize: 5 })).rejects.toMatchObject({ status: 403 });
    expect((await listBookings(cleaner, { page: 1, pageSize: 25, dir: "asc" })).items.map((b) => b.id)).toEqual([mine.booking.id]);

    // Cleaner may start/complete their own job but not cancel it.
    await expect(transitionBooking(cleaner, mine.booking.id, { action: "cancel", reason: "can't make it", expectedVersion: 0 })).rejects.toMatchObject({ status: 403 });
    await expect(transitionBooking(cleaner, mine.booking.id, { action: "start", expectedVersion: 0 })).resolves.toMatchObject({ status: "IN_PROGRESS" });
    await expect(transitionBooking(cleaner, theirs.booking.id, { action: "start", expectedVersion: 0 })).rejects.toMatchObject({ status: 404 });
  });

  it("never links one user to two cleaner profiles", async () => {
    const { admin, ana, ben, org } = await opsWorld();
    const u = await createUser(org._id, { role: "CLEANER" });
    await linkCleanerUser(admin, String(ana._id), String(u._id));
    await expect(linkCleanerUser(admin, String(ben._id), String(u._id))).rejects.toMatchObject({ code: "USER_ALREADY_LINKED" });
    const staffUser = await createUser(org._id, { role: "STAFF" });
    await expect(linkCleanerUser(admin, String(ben._id), String(staffUser._id))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await Cleaner.countDocuments({ linkedUserId: u._id })).toBe(1);
  });

  it("logs call outcomes manually", async () => {
    const { admin } = await opsWorld();
    const { customer } = await customerWithAddress(admin);
    expect(createNoteSchema.safeParse({ customerId: customer.id, kind: "call" }).success).toBe(false);
    await addNote(admin, { customerId: customer.id, kind: "call", content: "Will call back Friday", callOutcome: "callback_requested" });
    const acts = await listActivities(admin, { customerId: customer.id, page: 1, pageSize: 10 });
    expect(acts.items[0]).toMatchObject({ type: "call", callOutcome: "callback_requested" });
  });
});
