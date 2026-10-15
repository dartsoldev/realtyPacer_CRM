import "server-only";
import { Types, type PipelineStage } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Booking } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { Payment } from "@/lib/db/models/payment";
import type { BookingStatus } from "@/lib/domain/constants";
import { Errors } from "@/lib/http/errors";
import { customFieldDefsFor } from "@/modules/custom-fields/service";
import { conditionSchema, MAX_CONDITIONS } from "./definition";
import { andOf, compileFilters, fieldRegistry } from "./filters";

/**
 * The simple “customer & service” filter screen (Excel-style): every filter
 * is ANDed; several values in one filter mean “is any of”. Rows are service
 * lines of matching bookings (completed only unless a status filter is set),
 * grouped per customer. Paid = payments applied to that specific service line
 * (net of refunds) — never booking prices, never other services on the same
 * booking. Totals cover the whole filtered result, not just the page.
 */

export const SYSTEM_COLUMNS = ["phone", "email", "customerCity", "tags", "points"] as const;

export const customerFilterSchema = z
  .object({
    conditions: z.array(conditionSchema).max(MAX_CONDITIONS).default([]),
    columns: z.array(z.string().regex(/^(?:phone|email|customerCity|tags|points|cf:cf_[a-z0-9]{8})$/)).max(20).default(["phone", "points"]),
    sort: z.enum(["recent", "name", "paid", "services"]).default("recent"),
    page: z.number().int().min(1).max(10_000).default(1),
    pageSize: z.number().int().min(1).max(100).default(25),
  })
  .strict();

const LINES_PER_CUSTOMER = 30;

export type CustomerFilterLine = { bookingId: string; reference: string; date: string; service: string; quantity: number; city: string; address: string; paidCents: number | null; status: BookingStatus; cleaners: string[] };
export type CustomerFilterRow = {
  customerId: string;
  name: string;
  bookings: number;
  services: number;
  paidCents: number | null;
  lastServiceDate: string;
  columns: Record<string, unknown>;
  lines: CustomerFilterLine[];
  moreLines: number;
};

export async function runCustomerFilter(user: CurrentUser, raw: unknown) {
  if (!user.permissions.has("reports:read") || !user.permissions.has("customers:read")) throw Errors.forbidden();
  const input = customerFilterSchema.parse(raw);
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  const tz = user.organization.timezone;
  const specs = await fieldRegistry(user, "service_filter");
  const compiled = compileFilters(specs, input.conditions, false, tz);
  const money = user.permissions.has("financials:read");
  const points = user.permissions.has("loyalty:read");
  const hasStatus = input.conditions.some((c) => c.field === "status");

  const stages: PipelineStage[] = [
    { $match: andOf([{ organizationId: orgId, ...(hasStatus ? {} : { status: "COMPLETED" }) }, ...compiled.booking, ...compiled.line.filter((f) => Object.keys(f)[0]?.startsWith("lineItems."))]) },
  ];
  if (compiled.customer.length) {
    stages.push(
      { $lookup: { from: Customer.collection.name, localField: "customerId", foreignField: "_id", as: "cust", pipeline: [{ $match: { organizationId: orgId } }, { $project: { searchName: 1, tags: 1, customerType: 1, contactSource: 1, outstandingCents: 1, pointsBalance: 1, customFields: 1, addressCities: 1 } }] } },
      { $unwind: "$cust" },
      { $match: andOf(compiled.customer) },
    );
  }
  stages.push({ $unwind: "$lineItems" });
  if (compiled.line.length) stages.push({ $match: andOf(compiled.line) });
  stages.push(
    {
      $project: {
        customerId: 1,
        bookingId: "$_id",
        reference: 1,
        date: "$scheduledStartAt",
        service: "$lineItems.name",
        quantity: "$lineItems.quantity",
        city: "$addressSnapshot.city",
        address: "$addressSnapshot.line1",
        paidCents: { $ifNull: ["$lineItems.allocatedCents", 0] },
        status: 1,
        cleanerIds: "$assignedCleanerIds",
      },
    },
    { $sort: { date: -1, _id: -1 } },
  );
  const sortStage: Record<string, 1 | -1> = input.sort === "paid" ? { paidCents: -1, _id: 1 } : input.sort === "services" ? { services: -1, _id: 1 } : input.sort === "name" ? { name: 1, _id: 1 } : { lastServiceDate: -1, _id: 1 };
  const nameLookup: PipelineStage[] = [
    { $lookup: { from: Customer.collection.name, localField: "_id", foreignField: "_id", as: "c", pipeline: [{ $project: { searchName: 1 } }] } },
    { $addFields: { name: { $first: "$c.searchName" } } },
  ];
  const [res] = await Booking.aggregate<{
    totals: { customers: number; bookings: number; services: number; paidCents: number }[];
    ids: { _id: Types.ObjectId }[];
    rows: { _id: Types.ObjectId; bookings: number; services: number; paidCents: number; lastServiceDate: Date; lines: Record<string, unknown>[] }[];
  }>(
    [
      ...stages,
      {
        $facet: {
          totals: [
            { $group: { _id: null, customers: { $addToSet: "$customerId" }, bookings: { $addToSet: "$bookingId" }, services: { $sum: 1 }, paidCents: { $sum: "$paidCents" } } },
            { $project: { _id: 0, customers: { $size: "$customers" }, bookings: { $size: "$bookings" }, services: 1, paidCents: 1 } },
          ],
          ids: [{ $group: { _id: "$customerId" } }],
          rows: [
            { $group: { _id: "$customerId", b: { $addToSet: "$bookingId" }, services: { $sum: 1 }, paidCents: { $sum: "$paidCents" }, lastServiceDate: { $max: "$date" }, lines: { $push: "$$ROOT" } } },
            { $addFields: { bookings: { $size: "$b" } } },
            { $project: { b: 0 } },
            ...((input.sort === "name" ? [...nameLookup, { $sort: sortStage }] : [{ $sort: sortStage }]) as never[]),
            { $skip: (input.page - 1) * input.pageSize },
            { $limit: input.pageSize },
          ],
        },
      },
    ],
    { allowDiskUse: true },
  );

  const t = res?.totals[0] ?? { customers: 0, bookings: 0, services: 0, paidCents: 0 };
  const pageRows = res?.rows ?? [];
  const ids = pageRows.map((r) => r._id);
  const [customers, cleaners, cfDefs] = await Promise.all([
    Customer.find({ _id: { $in: ids }, organizationId: orgId }).select("name phone phoneDisplay email primaryCity tags pointsBalance customFields").lean(),
    Cleaner.find({ _id: { $in: [...new Set(pageRows.flatMap((r) => r.lines.slice(0, LINES_PER_CUSTOMER).flatMap((l) => (l.cleanerIds as Types.ObjectId[]).map(String))))] }, organizationId: orgId }).select("name").lean(),
    customFieldDefsFor(user.organizationId, "customer"),
  ]);
  const byId = new Map(customers.map((c) => [String(c._id), c]));
  const cleanerName = new Map(cleaners.map((c) => [String(c._id), c.name]));
  const activeDefs = new Map(cfDefs.filter((d) => !d.archived).map((d) => [`cf:${d.key}`, d]));
  const columns = input.columns.filter((c) => (c === "points" ? points : c.startsWith("cf:") ? activeDefs.has(c) : true));

  // Money received but never applied to a service can't be attributed to one; report it instead of guessing.
  let unattributed: { cents: number; customers: number } | null = null;
  if (money && res?.ids.length) {
    const [u] = await Payment.aggregate<{ cents: number; customers: string[] }>([
      { $match: { organizationId: orgId, status: "POSTED", unallocatedCents: { $gt: 0 }, customerId: { $in: res.ids.map((x) => x._id) } } },
      { $group: { _id: null, cents: { $sum: "$unallocatedCents" }, customers: { $addToSet: "$customerId" } } },
    ]);
    unattributed = u ? { cents: u.cents, customers: u.customers.length } : { cents: 0, customers: 0 };
  }

  const rows: CustomerFilterRow[] = pageRows.map((r) => {
    const c = byId.get(String(r._id));
    const cols: Record<string, unknown> = {};
    for (const col of columns) {
      if (col === "phone") cols.phone = c?.phoneDisplay ?? c?.phone ?? null;
      else if (col === "email") cols.email = c?.email ?? null;
      else if (col === "customerCity") cols.customerCity = c?.primaryCity ?? null;
      else if (col === "tags") cols.tags = c?.tags ?? [];
      else if (col === "points") cols.points = c?.pointsBalance ?? 0;
      else cols[col] = ((c?.customFields ?? {}) as Record<string, unknown>)[col.slice(3)] ?? null;
    }
    return {
      customerId: String(r._id),
      name: c?.name ?? "—",
      bookings: r.bookings,
      services: r.services,
      paidCents: money ? r.paidCents : null,
      lastServiceDate: r.lastServiceDate.toISOString(),
      columns: cols,
      lines: r.lines.slice(0, LINES_PER_CUSTOMER).map((l) => ({
        bookingId: String(l.bookingId),
        reference: String(l.reference),
        date: (l.date as Date).toISOString(),
        service: String(l.service),
        quantity: Number(l.quantity),
        city: String(l.city ?? ""),
        address: String(l.address ?? ""),
        paidCents: money ? Number(l.paidCents) : null,
        status: l.status as BookingStatus,
        cleaners: (l.cleanerIds as Types.ObjectId[]).map((id) => cleanerName.get(String(id)) ?? "Former cleaner"),
      })),
      moreLines: Math.max(0, r.lines.length - LINES_PER_CUSTOMER),
    };
  });

  return {
    asOf: new Date().toISOString(),
    timezone: tz,
    currency: user.organization.currency,
    statusNote: hasStatus ? null : "Completed jobs only (add a Booking status filter to include others).",
    totals: { customers: t.customers, bookings: t.bookings, services: t.services, paidCents: money ? t.paidCents : null },
    unattributed,
    columns: columns.map((key) => ({ key, label: key === "phone" ? "Phone" : key === "email" ? "Email" : key === "customerCity" ? "Customer city (current)" : key === "tags" ? "Tags" : key === "points" ? "Points balance" : (activeDefs.get(key)?.label ?? key) })),
    availableColumns: [
      { key: "phone", label: "Phone" },
      { key: "email", label: "Email" },
      { key: "customerCity", label: "Customer city (current)" },
      { key: "tags", label: "Tags" },
      ...(points ? [{ key: "points", label: "Points balance" }] : []),
      ...[...activeDefs.values()].map((d) => ({ key: `cf:${d.key}`, label: d.label })),
    ],
    customFieldOptions: Object.fromEntries([...activeDefs.values()].map((d) => [`cf:${d.key}`, { type: d.dataType, options: d.options.map((o) => ({ value: o.value, label: o.label })) }])),
    rows,
    page: input.page,
    pageSize: input.pageSize,
    totalPages: Math.max(1, Math.ceil(t.customers / input.pageSize)),
    moneyVisible: money,
  };
}

export type CustomerFilterResult = Awaited<ReturnType<typeof runCustomerFilter>>;
