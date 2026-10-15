/**
 * NON-PRODUCTION: builds a realistic synthetic dataset in a throwaway
 * database and measures the heavy queries (lists, search, calendar, reports,
 * customer finance) through the real service functions.
 *
 *   MONGODB_URI=mongodb://…/realtypacer_perf_<anything> npx tsx --conditions=react-server scripts/perf-dataset.ts
 *
 * Refuses unless the database name starts with "realtypacer_perf". All data is
 * fictional (example.test, 555 numbers). Drops the database at the end unless --keep.
 */
import "./_env";
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { Types } from "mongoose";
import { resolveUser } from "@/lib/auth/current-user";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { ALL_MODELS } from "@/lib/db/models";
import { Booking } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { Organization } from "@/lib/db/models/organization";
import { Payment } from "@/lib/db/models/payment";
import { Service } from "@/lib/db/models/service";
import { ServiceAddress } from "@/lib/db/models/service-address";
import { User } from "@/lib/db/models/user";
import { normalizeCity } from "@/lib/domain/normalize";
import { listBookings } from "@/modules/bookings/service";
import { calendarEvents } from "@/modules/bookings/service";
import { listCustomers, lookupCustomers } from "@/modules/customers/service";
import { customerFinancialSummary } from "@/modules/finance/summary";
import { listPayments } from "@/modules/finance/payments";
import { runReport } from "@/modules/reports/engine";
import { bookingListQuery } from "@/modules/bookings/schemas";
import { customerListQuery } from "@/modules/customers/schemas";
import { paymentListQuery } from "@/modules/finance/payments";

const { values } = parseArgs({ options: { customers: { type: "string", default: "5000" }, bookings: { type: "string", default: "40000" }, keep: { type: "boolean", default: false } } });
const N_CUSTOMERS = Number(values.customers);
const N_BOOKINGS = Number(values.bookings);
const CITIES = ["Toronto", "Mississauga", "Brampton", "Oakville", "Markham", "Vaughan", "Richmond Hill", "Burlington", "Milton", "Ajax"];
const pick = <T,>(a: readonly T[]) => a[randomInt(a.length)]!;

async function timed<T>(label: string, fn: () => Promise<T>, runs = 3) {
  const times: number[] = [];
  let out: T | undefined;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = await fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  console.log(`${label.padEnd(58)} median ${times[Math.floor(times.length / 2)]!.toFixed(0).padStart(5)} ms  (min ${times[0]!.toFixed(0)}, max ${times[times.length - 1]!.toFixed(0)})`);
  return out!;
}

async function main() {
  const conn = await connectDb();
  const dbName = conn.connection.name;
  if (!/^realtypacer_perf/.test(dbName)) throw new Error(`Refusing: database "${dbName}" is not a realtypacer_perf* database`);
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to run with NODE_ENV=production");
  await Promise.all(ALL_MODELS.map((m) => m.init()));

  console.log(`Seeding ${N_CUSTOMERS} customers, ${N_BOOKINGS} bookings into ${dbName}…`);
  const t0 = performance.now();
  const org = await Organization.create({ name: "Perf Co", displayName: "Perf Co" });
  const orgId = org._id;
  const user = await User.create({ organizationId: orgId, email: "perf.admin@example.test", name: "Perf Admin", role: "ADMIN", status: "active", emailVerifiedAt: new Date(), passwordHash: "x" });
  const services = await Service.insertMany(Array.from({ length: 30 }, (_, i) => ({ organizationId: orgId, name: `Service ${i + 1}`, searchName: `service ${i + 1}`, defaultPriceCents: 2000 + randomInt(20000), currency: "CAD", durationMinutes: 30 + randomInt(4) * 30, unitLabel: "item" })));
  const cleaners = await Cleaner.insertMany(Array.from({ length: 25 }, (_, i) => ({ organizationId: orgId, name: `Cleaner ${i + 1}`, searchName: `cleaner ${i + 1}`, phone: `+1416555${String(1000 + i).slice(-4)}` })));

  const customers: { _id: Types.ObjectId; city: string }[] = [];
  for (let off = 0; off < N_CUSTOMERS; off += 1000) {
    const batch = Array.from({ length: Math.min(1000, N_CUSTOMERS - off) }, (_, j) => {
      const i = off + j;
      const city = pick(CITIES);
      const name = `Customer${i} Example`;
      return { _id: new Types.ObjectId(), organizationId: orgId, customerType: "individual", firstName: `Customer${i}`, lastName: "Example", name, searchName: name.toLowerCase(), phone: `+1905555${String(i).padStart(4, "0").slice(-4)}`, phoneDigits: `1905555${String(i).padStart(4, "0").slice(-4)}`, phoneDisplay: "(905) 555-0000", email: `customer${i}@example.test`, tags: i % 7 === 0 ? ["vip"] : [], addressCities: [normalizeCity(city)], primaryCity: city };
    });
    await Customer.insertMany(batch, { ordered: false });
    customers.push(...batch.map((b) => ({ _id: b._id, city: b.primaryCity })));
  }
  const addresses = new Map<string, Types.ObjectId>();
  for (let off = 0; off < customers.length; off += 1000) {
    const docs = customers.slice(off, off + 1000).map((c, j) => {
      const _id = new Types.ObjectId();
      addresses.set(String(c._id), _id);
      return { _id, organizationId: orgId, customerId: c._id, label: "Home", line1: `${off + j} Example Street`, city: c.city, cityNormalized: normalizeCity(c.city), region: "ON", country: "Canada", isPrimary: true };
    });
    await ServiceAddress.insertMany(docs, { ordered: false });
  }
  const now = Date.now();
  const span = 3 * 365 * 86_400_000;
  let paymentsMade = 0;
  for (let off = 0; off < N_BOOKINGS; off += 1000) {
    const docs = Array.from({ length: Math.min(1000, N_BOOKINGS - off) }, (_, j) => {
      const c = pick(customers);
      const start = new Date(now - span + randomInt(span + 60 * 86_400_000));
      const completed = start.getTime() < now;
      const lines = Array.from({ length: 1 + randomInt(3) }, () => {
        const s = pick(services);
        const q = 1 + randomInt(3);
        const total = q * s.defaultPriceCents;
        return { _id: new Types.ObjectId(), serviceId: s._id, name: s.name, unitLabel: "item", quantity: q, unitPriceCents: s.defaultPriceCents, catalogUnitPriceCents: s.defaultPriceCents, durationMinutes: s.durationMinutes, lineTotalCents: total, discountCents: 0, netCents: total, taxCents: 0, chargedCents: total, adjustmentCents: 0, allocatedCents: completed && randomInt(10) < 7 ? total : 0 };
      });
      const sum = (k: "lineTotalCents" | "chargedCents" | "allocatedCents") => lines.reduce((s, l) => s + l[k], 0);
      return {
        organizationId: orgId,
        reference: `RP-PERF-${off + j}`,
        customerId: c._id,
        serviceAddressId: addresses.get(String(c._id)),
        assignedCleanerIds: [pick(cleaners)._id],
        scheduledStartAt: start,
        scheduledEndAt: new Date(start.getTime() + 2 * 3600_000),
        timezone: "America/Toronto",
        status: completed ? (randomInt(20) === 0 ? "CANCELLED" : "COMPLETED") : "SCHEDULED",
        addressSnapshot: { line1: "1 Example Street", city: c.city, cityNormalized: normalizeCity(c.city), region: "ON", country: "Canada" },
        lineItems: lines,
        currency: "CAD",
        subtotalCents: sum("lineTotalCents"),
        billingState: completed ? "FINALIZED" : "DRAFT",
        netCents: sum("lineTotalCents"),
        chargedCents: sum("chargedCents"),
        allocatedCents: sum("allocatedCents"),
        version: 0,
      };
    });
    const inserted = await Booking.collection.insertMany(docs as never[], { ordered: false });
    // One receipt per paid booking (allocations to each line).
    const pays = docs
      .map((d, k) => ({ d, id: inserted.insertedIds[k] }))
      .filter(({ d }) => d.allocatedCents > 0)
      .map(({ d, id }) => ({
        organizationId: orgId,
        receiptNumber: `PMT-PERF-${off}-${paymentsMade}`,
        idempotencyKey: `perf-${off}-${paymentsMade++}`,
        customerId: d.customerId,
        amountCents: d.allocatedCents,
        currency: "CAD",
        receivedAt: new Date(d.scheduledStartAt.getTime() + 86_400_000),
        method: "e_transfer",
        status: "POSTED",
        allocations: d.lineItems.map((l) => ({ _id: new Types.ObjectId(), bookingId: id, lineItemId: l._id, serviceId: l.serviceId, amountCents: l.allocatedCents, refundedCents: 0, allocatedAt: new Date(), source: "receipt", bookingReference: d.reference, city: d.addressSnapshot.city, cityNormalized: d.addressSnapshot.cityNormalized, serviceName: l.name })),
        netAllocatedCents: d.allocatedCents,
        unallocatedCents: 0,
        refundedCents: 0,
        revision: 0,
      }));
    if (pays.length) await Payment.collection.insertMany(pays as never[], { ordered: false });
  }
  console.log(`Seeded in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${N_CUSTOMERS} customers, ${N_CUSTOMERS} addresses, ${N_BOOKINGS} bookings, ${paymentsMade} payments.\n`);

  const actor = (await resolveUser({ userId: String(user._id), organizationId: String(orgId), sessionVersion: 0 })).user!;
  const year = new Date().getFullYear();
  const sofa = String(services[0]!._id);
  await timed("Customer list (page 1, sorted by name)", () => listCustomers(actor, customerListQuery.parse({})));
  await timed("Customer search 'customer42' (name)", () => listCustomers(actor, customerListQuery.parse({ q: "customer42" })));
  await timed("Customer search by partial phone '555004'", () => listCustomers(actor, customerListQuery.parse({ q: "555004" })));
  await timed("Customer autocomplete 'custom'", () => lookupCustomers(actor, "custom"));
  await timed("Customer list, city filter Mississauga", () => listCustomers(actor, customerListQuery.parse({ city: "Mississauga" })));
  await timed("Booking list (default, page 1)", () => listBookings(actor, bookingListQuery.parse({})));
  await timed("Booking list, city + 1-year range", () => listBookings(actor, bookingListQuery.parse({ city: "Toronto", from: `${year - 1}-01-01`, to: `${year - 1}-12-31` })));
  await timed("Calendar, one month", () => calendarEvents(actor, { start: `${year}-01-01`, end: `${year}-01-31` }));
  await timed("Payments list (page 1) with totals", () => listPayments(actor, paymentListQuery.parse({})));
  const base = { datePreset: "custom" as const, from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, statuses: ["COMPLETED" as const], filters: { logic: "and" as const, conditions: [] as never[] } };
  await timed("Report: service performance, 1 year, no filters", () => runReport(actor, { ...base, mode: "service" }));
  await timed("Report: service, 1 year, city AND service", () => runReport(actor, { ...base, mode: "service", filters: { logic: "and", conditions: [{ field: "city", op: "any_of", value: ["Mississauga", "Toronto"] }, { field: "service", op: "eq", value: sofa }] as never[] } }));
  await timed("Report: customer summary, 1 year", () => runReport(actor, { ...base, mode: "customers" }));
  await timed("Report: cash received, 1 year", () => runReport(actor, { ...base, mode: "cash" }));
  await timed("Customer financial summary (lifetime)", () => customerFinancialSummary(actor, String(customers[0]!._id)));

  // Index usage for the main report match.
  const plan = await Booking.collection.find({ organizationId: orgId, scheduledStartAt: { $gte: new Date(`${year - 1}-01-01`), $lt: new Date(`${year}-01-01`) }, status: { $in: ["COMPLETED"] } }).explain("executionStats");
  const stage = JSON.stringify(plan.queryPlanner.winningPlan).match(/"stage":"(IXSCAN|COLLSCAN)"/)?.[1];
  console.log(`\nBooking report match plan: ${stage}; examined ${plan.executionStats.totalDocsExamined} docs / keys ${plan.executionStats.totalKeysExamined}, returned ${plan.executionStats.nReturned}`);

  if (!values.keep) {
    await conn.connection.dropDatabase();
    console.log(`Dropped ${dbName}.`);
  }
}

main()
  .catch((err) => {
    console.error("perf failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
