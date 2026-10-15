import "server-only";
import { Types, type PipelineStage } from "mongoose";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Booking } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { Payment } from "@/lib/db/models/payment";
import { localDaysRange } from "@/lib/domain/zoned-time";
import { Errors } from "@/lib/http/errors";
import { andOf, compileFilters, fieldRegistry, type CompiledFilters } from "./filters";
import { MAX_PAGE_SIZE, MAX_RANGE_DAYS, type ColumnMeta, type ReportDefinition } from "./definition";

/**
 * Report semantics (see PROJECT_STATE.md → "Report definitions"):
 *
 * service   – unit = booking service line. Date = scheduled service date in
 *             the org timezone; city = booking address snapshot; default status
 *             COMPLETED. Money totals include only matched lines. "Charged" counts
 *             FINALIZED lines (after adjustments); DRAFT lines appear as estimates.
 *             "Net paid toward matching services" = net allocated to those lines, as of now.
 * cash      – unit = money movement. Date = receipt / refund date. Receipts are
 *             split into their allocation portions plus an explicit "Unallocated"
 *             portion; refunds into the portions they reduced. City/service come
 *             only from allocations. Reversed receipts are excluded entirely.
 * customers – one row per distinct customer with matched service lines (same
 *             rules as service), plus separately labelled lifetime columns and
 *             the current points balance once per customer.
 */

export type RunOptions = { page?: number; pageSize?: number; lenient?: boolean; exportAll?: boolean; maxRows?: number };

type Money = number | null;

export type ReportResult = {
  mode: ReportDefinition["mode"];
  asOf: string;
  timezone: string;
  currency: string;
  range: { from: string; to: string; basis: string };
  statuses: string[] | null;
  applied: CompiledFilters["applied"];
  warnings: string[];
  notes: string[];
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
  totals: Record<string, Money | number | string | null>;
  breakdowns: { key: string; title: string; note?: string; rows: { label: string; values: Record<string, number | null> }[] }[];
  unitsByLabel?: { unit: string; quantity: number; lines: number }[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  moneyVisible: boolean;
};

function bounds(def: ReportDefinition, tz: string) {
  const { start, end } = localDaysRange(def.from, def.to, tz);
  if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_RANGE_DAYS + 1) throw Errors.validation("Choose a date range of at most about three years.");
  return { start, end };
}

function canMoney(user: CurrentUser) {
  return user.permissions.has("financials:read") && user.permissions.has("pricing:read");
}

function sortStage(def: ReportDefinition, allowed: Record<string, string>, fallback: Record<string, 1 | -1>): Record<string, 1 | -1> {
  const key = def.sort?.key && allowed[def.sort.key];
  const dir = def.sort?.dir === "asc" ? 1 : -1;
  return key ? { [key]: dir, _id: dir } : fallback;
}

function stripMoney(rows: Record<string, unknown>[], cols: ColumnMeta[]) {
  const money = new Set(cols.filter((c) => c.money).map((c) => c.key));
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, money.has(k) ? null : v])));
}

// ---------------------------------------------------------------------------
// Shared line pipeline for service + customers modes
// ---------------------------------------------------------------------------

async function linePipeline(user: CurrentUser, def: ReportDefinition, compiled: CompiledFilters): Promise<PipelineStage[]> {
  const orgId = new Types.ObjectId(user.organizationId);
  const { start, end } = bounds(def, user.organization.timezone);
  const bookingMatch = andOf([{ organizationId: orgId, scheduledStartAt: { $gte: start, $lt: end }, status: { $in: def.statuses } }, ...compiled.booking, ...compiled.line.filter((f) => Object.keys(f)[0]?.startsWith("lineItems."))]);
  const stages: PipelineStage[] = [{ $match: bookingMatch }];
  if (compiled.customer.length) {
    stages.push(
      { $lookup: { from: Customer.collection.name, localField: "customerId", foreignField: "_id", as: "cust", pipeline: [{ $match: { organizationId: orgId } }, { $project: { searchName: 1, tags: 1, customerType: 1, contactSource: 1, outstandingCents: 1, pointsBalance: 1, customFields: 1 } }] } },
      { $unwind: "$cust" },
      { $match: andOf(compiled.customer) },
    );
  }
  stages.push(
    { $unwind: "$lineItems" },
    {
      $addFields: {
        finalized: { $eq: ["$billingState", "FINALIZED"] },
        lineBalanceCents: { $cond: [{ $eq: ["$billingState", "FINALIZED"] }, { $subtract: [{ $add: ["$lineItems.chargedCents", { $ifNull: ["$lineItems.adjustmentCents", 0] }] }, { $ifNull: ["$lineItems.allocatedCents", 0] }] }, 0] },
      },
    },
  );
  if (compiled.line.length) stages.push({ $match: andOf(compiled.line) });
  stages.push({
    $project: {
      bookingId: "$_id",
      reference: 1,
      customerId: 1,
      serviceDate: "$scheduledStartAt",
      status: 1,
      billingState: 1,
      city: "$addressSnapshot.city",
      cleanerIds: "$assignedCleanerIds",
      lineItemId: "$lineItems._id",
      serviceId: "$lineItems.serviceId",
      service: "$lineItems.name",
      quantity: "$lineItems.quantity",
      unit: "$lineItems.unitLabel",
      grossCents: "$lineItems.lineTotalCents",
      discountCents: { $ifNull: ["$lineItems.discountCents", 0] },
      netCents: { $ifNull: ["$lineItems.netCents", "$lineItems.lineTotalCents"] },
      taxCents: { $ifNull: ["$lineItems.taxCents", 0] },
      // Owed only when finalized (after adjustments); drafts are estimates.
      chargedCents: { $cond: ["$finalized", { $add: ["$lineItems.chargedCents", { $ifNull: ["$lineItems.adjustmentCents", 0] }] }, 0] },
      estimateCents: { $cond: ["$finalized", 0, { $ifNull: ["$lineItems.chargedCents", "$lineItems.lineTotalCents"] }] },
      paidCents: { $ifNull: ["$lineItems.allocatedCents", 0] },
      outstandingCents: "$lineBalanceCents",
      customFields: 1,
    },
  });
  return stages;
}

const SERVICE_COLUMNS: ColumnMeta[] = [
  { key: "serviceDate", label: "Service date", defaultVisible: true, sortable: true },
  { key: "reference", label: "Booking", defaultVisible: true, sortable: true },
  { key: "customer", label: "Customer", defaultVisible: true, sortable: false },
  { key: "city", label: "City (booking)", defaultVisible: true, sortable: true },
  { key: "service", label: "Service", defaultVisible: true, sortable: true },
  { key: "quantity", label: "Quantity", defaultVisible: true, sortable: false },
  { key: "status", label: "Job status", defaultVisible: false, sortable: false },
  { key: "billingState", label: "Billing", defaultVisible: true, sortable: false },
  { key: "cleaners", label: "Cleaners", defaultVisible: false, sortable: false },
  { key: "grossCents", label: "Gross", money: true, defaultVisible: false, sortable: true },
  { key: "discountCents", label: "Discount", money: true, defaultVisible: false, sortable: false },
  { key: "netCents", label: "Net service value", money: true, defaultVisible: true, sortable: true },
  { key: "taxCents", label: "Tax", money: true, defaultVisible: false, sortable: false },
  { key: "chargedCents", label: "Charged (finalized)", money: true, defaultVisible: true, sortable: true },
  { key: "estimateCents", label: "Draft estimate", money: true, defaultVisible: false, sortable: false },
  { key: "paidCents", label: "Net paid toward line", money: true, defaultVisible: true, sortable: true },
  { key: "outstandingCents", label: "Outstanding", money: true, defaultVisible: true, sortable: true },
];

const MONEY_SUMS = {
  grossCents: { $sum: "$grossCents" },
  discountCents: { $sum: "$discountCents" },
  netCents: { $sum: "$netCents" },
  taxCents: { $sum: "$taxCents" },
  chargedCents: { $sum: "$chargedCents" },
  estimateCents: { $sum: "$estimateCents" },
  paidCents: { $sum: "$paidCents" },
  outstandingCents: { $sum: "$outstandingCents" },
};

async function resolveNames(user: CurrentUser, customerIds: Types.ObjectId[], cleanerIds: Types.ObjectId[]) {
  const [cs, cl] = await Promise.all([
    Customer.find({ _id: { $in: customerIds }, organizationId: user.organizationId }).select("name pointsBalance outstandingCents creditCents").lean(),
    cleanerIds.length && user.permissions.has("cleaners:read") ? Cleaner.find({ _id: { $in: cleanerIds }, organizationId: user.organizationId }).select("name").lean() : [],
  ]);
  return { customers: new Map(cs.map((c) => [String(c._id), c])), cleaners: new Map(cl.map((c) => [String(c._id), c.name])) };
}

function customFieldColumns(specs: Awaited<ReturnType<typeof fieldRegistry>>): ColumnMeta[] {
  return specs.filter((s) => s.key.startsWith("cf:booking:")).map((s) => ({ key: s.key, label: s.label, defaultVisible: false, sortable: false }));
}

export async function runServiceReport(user: CurrentUser, def: ReportDefinition, opts: RunOptions = {}): Promise<ReportResult> {
  const specs = await fieldRegistry(user, "service");
  const compiled = compileFilters(specs, def.filters.conditions, opts.lenient);
  const stages = await linePipeline(user, def, compiled);
  const pageSize = opts.exportAll ? (opts.maxRows ?? 10_000) : Math.min(opts.pageSize ?? 25, MAX_PAGE_SIZE);
  const page = opts.exportAll ? 1 : Math.max(1, opts.page ?? 1);
  const sort = sortStage(def, { serviceDate: "serviceDate", reference: "reference", city: "city", service: "service", grossCents: "grossCents", netCents: "netCents", chargedCents: "chargedCents", paidCents: "paidCents", outstandingCents: "outstandingCents" }, { serviceDate: -1, _id: -1 });
  const tz = user.organization.timezone;
  const [res] = await Booking.aggregate<{
    totals: Record<string, number>[];
    units: { _id: string; quantity: number; lines: number }[];
    byCity: { _id: string; bookings: number; lines: number; netCents: number; chargedCents: number; paidCents: number; outstandingCents: number }[];
    byService: { _id: string; bookings: number; lines: number; netCents: number; chargedCents: number; paidCents: number; outstandingCents: number }[];
    byMonth: { _id: string; bookings: number; lines: number; netCents: number; chargedCents: number; paidCents: number; outstandingCents: number }[];
    byCustomer: { _id: Types.ObjectId; bookings: number; lines: number; netCents: number; chargedCents: number; paidCents: number; outstandingCents: number }[];
    byCleaner: { _id: Types.ObjectId; bookings: number }[];
    rows: Record<string, unknown>[];
  }>(
    [
      ...stages,
      {
        $facet: {
          totals: [{ $group: { _id: null, customers: { $addToSet: "$customerId" }, bookings: { $addToSet: "$bookingId" }, lines: { $sum: 1 }, ...MONEY_SUMS } }, { $addFields: { customers: { $size: "$customers" }, bookings: { $size: "$bookings" } } }],
          units: [{ $group: { _id: "$unit", quantity: { $sum: "$quantity" }, lines: { $sum: 1 } } }, { $sort: { _id: 1 } }],
          byCity: [{ $group: { _id: "$city", b: { $addToSet: "$bookingId" }, lines: { $sum: 1 }, netCents: { $sum: "$netCents" }, chargedCents: { $sum: "$chargedCents" }, paidCents: { $sum: "$paidCents" }, outstandingCents: { $sum: "$outstandingCents" } } }, { $addFields: { bookings: { $size: "$b" } } }, { $project: { b: 0 } }, { $sort: { netCents: -1 } }, { $limit: 50 }],
          byService: [{ $group: { _id: "$service", b: { $addToSet: "$bookingId" }, lines: { $sum: 1 }, netCents: { $sum: "$netCents" }, chargedCents: { $sum: "$chargedCents" }, paidCents: { $sum: "$paidCents" }, outstandingCents: { $sum: "$outstandingCents" } } }, { $addFields: { bookings: { $size: "$b" } } }, { $project: { b: 0 } }, { $sort: { netCents: -1 } }, { $limit: 50 }],
          byMonth: [{ $group: { _id: { $dateToString: { format: "%Y-%m", date: "$serviceDate", timezone: tz } }, b: { $addToSet: "$bookingId" }, lines: { $sum: 1 }, netCents: { $sum: "$netCents" }, chargedCents: { $sum: "$chargedCents" }, paidCents: { $sum: "$paidCents" }, outstandingCents: { $sum: "$outstandingCents" } } }, { $addFields: { bookings: { $size: "$b" } } }, { $project: { b: 0 } }, { $sort: { _id: 1 } }, { $limit: 60 }],
          byCustomer: [{ $group: { _id: "$customerId", b: { $addToSet: "$bookingId" }, lines: { $sum: 1 }, netCents: { $sum: "$netCents" }, chargedCents: { $sum: "$chargedCents" }, paidCents: { $sum: "$paidCents" }, outstandingCents: { $sum: "$outstandingCents" } } }, { $addFields: { bookings: { $size: "$b" } } }, { $project: { b: 0 } }, { $sort: { netCents: -1 } }, { $limit: 20 }],
          // Booking counts per cleaner: each booking once, no revenue split (no attribution rule).
          byCleaner: [{ $group: { _id: "$bookingId", cleaners: { $first: "$cleanerIds" } } }, { $unwind: "$cleaners" }, { $group: { _id: "$cleaners", bookings: { $sum: 1 } } }, { $sort: { bookings: -1 } }, { $limit: 50 }],
          rows: [{ $sort: sort }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }],
        },
      },
    ],
    { allowDiskUse: true },
  );
  const t = res?.totals[0] ?? {};
  const total = (t.lines as number) ?? 0;
  const rows = res?.rows ?? [];
  const names = await resolveNames(user, [...new Set([...rows.map((r) => String(r.customerId)), ...(res?.byCustomer ?? []).map((c) => String(c._id))])].map((x) => new Types.ObjectId(x)), [...new Set([...rows.flatMap((r) => (r.cleanerIds as Types.ObjectId[]).map(String)), ...(res?.byCleaner ?? []).map((c) => String(c._id))])].map((x) => new Types.ObjectId(x)));
  const cfCols = customFieldColumns(specs);
  const columns = [...SERVICE_COLUMNS.filter((c) => c.key !== "cleaners" || user.permissions.has("cleaners:read")), ...cfCols];
  const money = canMoney(user);
  let outRows: Record<string, unknown>[] = rows.map((r) => ({
    id: `${r.bookingId}:${r.lineItemId}`,
    bookingId: String(r.bookingId),
    customerId: String(r.customerId),
    serviceDate: (r.serviceDate as Date).toISOString(),
    reference: r.reference,
    customer: names.customers.get(String(r.customerId))?.name ?? "—",
    city: r.city,
    service: r.service,
    quantity: `${r.quantity} ${r.unit}`,
    status: r.status,
    billingState: r.billingState,
    cleaners: (r.cleanerIds as Types.ObjectId[]).map((id) => names.cleaners.get(String(id)) ?? "").filter(Boolean).join(", "),
    grossCents: r.grossCents,
    discountCents: r.discountCents,
    netCents: r.netCents,
    taxCents: r.taxCents,
    chargedCents: r.chargedCents,
    estimateCents: r.estimateCents,
    paidCents: r.paidCents,
    outstandingCents: r.outstandingCents,
    ...Object.fromEntries(cfCols.map((c) => [c.key, ((r.customFields ?? {}) as Record<string, unknown>)[c.key.split(":")[2]!] ?? null])),
  }));
  if (!money) outRows = stripMoney(outRows, columns);
  const mv = (v: unknown) => (money ? ((v as number) ?? 0) : null);
  const bd = (rowsIn: { _id: unknown; bookings: number; lines: number; netCents: number; chargedCents: number; paidCents: number; outstandingCents: number }[], label: (id: unknown) => string) =>
    rowsIn.map((x) => ({ label: label(x._id), values: { bookings: x.bookings, lines: x.lines, netCents: mv(x.netCents), chargedCents: mv(x.chargedCents), paidCents: mv(x.paidCents), outstandingCents: mv(x.outstandingCents) } }));
  return {
    mode: "service",
    asOf: new Date().toISOString(),
    timezone: tz,
    currency: user.organization.currency,
    range: { from: def.from, to: def.to, basis: `Scheduled service date (${tz}), ${def.from} to ${def.to} inclusive` },
    statuses: def.statuses,
    applied: compiled.applied,
    warnings: compiled.warnings,
    notes: [
      "Money totals include only the matched service lines (e.g. filtering a service excludes other services on the same booking).",
      "Charged = finalized charges after adjustments. Draft bookings are estimates, not amounts owed.",
      "Net paid toward matching services = payments applied to those lines minus refunded portions, as of now.",
      "Cleaner view counts each booking once per assigned cleaner; revenue is not split between cleaners.",
    ],
    columns,
    rows: outRows,
    totals: {
      uniqueCustomers: (t.customers as number) ?? 0,
      distinctBookings: (t.bookings as number) ?? 0,
      serviceLines: total,
      grossCents: mv(t.grossCents),
      discountCents: mv(t.discountCents),
      netCents: mv(t.netCents),
      taxCents: mv(t.taxCents),
      chargedCents: mv(t.chargedCents),
      estimateCents: mv(t.estimateCents),
      paidCents: mv(t.paidCents),
      outstandingCents: mv(t.outstandingCents),
    },
    unitsByLabel: (res?.units ?? []).map((u) => ({ unit: u._id ?? "item", quantity: u.quantity, lines: u.lines })),
    breakdowns: [
      { key: "city", title: "By city", rows: bd(res?.byCity ?? [], (id) => String(id ?? "—")) },
      { key: "service", title: "By service", rows: bd(res?.byService ?? [], (id) => String(id ?? "—")) },
      { key: "month", title: "By month (service date)", rows: bd(res?.byMonth ?? [], (id) => String(id)) },
      { key: "customer", title: "Top customers", rows: bd(res?.byCustomer ?? [], (id) => names.customers.get(String(id))?.name ?? "—") },
      { key: "cleaner", title: "Bookings per cleaner", note: "Each booking counted once per assigned cleaner; amounts are not attributed to individuals.", rows: (res?.byCleaner ?? []).map((x) => ({ label: names.cleaners.get(String(x._id)) ?? "Former cleaner", values: { bookings: x.bookings } })) },
    ],
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    moneyVisible: money,
  };
}

// ---------------------------------------------------------------------------
// Customer summary
// ---------------------------------------------------------------------------

const CUSTOMER_COLUMNS: ColumnMeta[] = [
  { key: "customer", label: "Customer", defaultVisible: true, sortable: true },
  { key: "bookings", label: "Matched bookings", defaultVisible: true, sortable: true },
  { key: "lines", label: "Matched service lines", defaultVisible: true, sortable: true },
  { key: "lastServiceDate", label: "Last matched service", defaultVisible: true, sortable: true },
  { key: "netCents", label: "Matched net service value", money: true, defaultVisible: true, sortable: true },
  { key: "chargedCents", label: "Matched charged", money: true, defaultVisible: true, sortable: true },
  { key: "paidCents", label: "Matched net paid", money: true, defaultVisible: true, sortable: true },
  { key: "outstandingCents", label: "Matched outstanding", money: true, defaultVisible: true, sortable: true },
  { key: "lifetimeOutstandingCents", label: "Lifetime outstanding (current)", money: true, defaultVisible: false, sortable: false },
  { key: "lifetimeCreditCents", label: "Unallocated credit (current)", money: true, defaultVisible: false, sortable: false },
  { key: "points", label: "Points balance (current)", defaultVisible: true, sortable: false },
];

export async function runCustomerReport(user: CurrentUser, def: ReportDefinition, opts: RunOptions = {}): Promise<ReportResult> {
  const specs = await fieldRegistry(user, "customers");
  const compiled = compileFilters(specs, def.filters.conditions, opts.lenient);
  const stages = await linePipeline(user, def, compiled);
  const pageSize = opts.exportAll ? (opts.maxRows ?? 10_000) : Math.min(opts.pageSize ?? 25, MAX_PAGE_SIZE);
  const page = opts.exportAll ? 1 : Math.max(1, opts.page ?? 1);
  const sort = sortStage(def, { customer: "name", bookings: "bookings", lines: "lines", lastServiceDate: "lastServiceDate", netCents: "netCents", chargedCents: "chargedCents", paidCents: "paidCents", outstandingCents: "outstandingCents" }, { netCents: -1, _id: 1 });
  const customerLookup: PipelineStage[] = [
    { $lookup: { from: Customer.collection.name, localField: "_id", foreignField: "_id", as: "c", pipeline: [{ $project: { name: 1, searchName: 1, pointsBalance: 1, outstandingCents: 1, creditCents: 1 } }] } },
    { $unwind: "$c" },
    { $addFields: { name: "$c.searchName" } },
  ];
  // Join customer details only for the page shown (all rows only when sorting by name).
  const byName = "name" in sort;
  const paging: PipelineStage[] = [{ $sort: sort }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }];
  const [res] = await Booking.aggregate<{ totals: Record<string, number>[]; count: { n: number }[]; rows: Record<string, unknown>[]; ids: { _id: Types.ObjectId }[] }>(
    [
      ...stages,
      {
        $facet: {
          totals: [{ $group: { _id: null, customers: { $addToSet: "$customerId" }, bookings: { $addToSet: "$bookingId" }, lines: { $sum: 1 }, ...MONEY_SUMS } }, { $addFields: { customers: { $size: "$customers" }, bookings: { $size: "$bookings" } } }],
          rows: [
            { $group: { _id: "$customerId", b: { $addToSet: "$bookingId" }, lines: { $sum: 1 }, lastServiceDate: { $max: "$serviceDate" }, netCents: { $sum: "$netCents" }, chargedCents: { $sum: "$chargedCents" }, paidCents: { $sum: "$paidCents" }, outstandingCents: { $sum: "$outstandingCents" } } },
            { $addFields: { bookings: { $size: "$b" } } },
            { $project: { b: 0 } },
            ...((byName ? [...customerLookup, ...paging] : [...paging, ...customerLookup]) as never[]),
          ],
          count: [{ $group: { _id: "$customerId" } }, { $count: "n" }],
          ids: user.permissions.has("loyalty:read") ? [{ $group: { _id: "$customerId" } }] : [{ $limit: 0 }],
        },
      },
    ],
    { allowDiskUse: true },
  );
  // Current points of all matched customers: one indexed query instead of a join per customer.
  const pointsAgg = res?.ids.length
    ? await Customer.aggregate<{ total: number }>([{ $match: { _id: { $in: res.ids.map((x) => x._id) }, organizationId: new Types.ObjectId(user.organizationId) } }, { $group: { _id: null, total: { $sum: "$pointsBalance" } } }])
    : [];
  const t = res?.totals[0] ?? {};
  const total = res?.count[0]?.n ?? 0;
  const money = canMoney(user);
  const points = user.permissions.has("loyalty:read");
  const mv = (v: unknown) => (money ? ((v as number) ?? 0) : null);
  const columns = CUSTOMER_COLUMNS.filter((c) => c.key !== "points" || points);
  let rows: Record<string, unknown>[] = (res?.rows ?? []).map((r) => {
    const c = r.c as { name: string; pointsBalance?: number; outstandingCents?: number; creditCents?: number };
    return {
      id: String(r._id),
      customerId: String(r._id),
      customer: c.name,
      bookings: r.bookings,
      lines: r.lines,
      lastServiceDate: (r.lastServiceDate as Date).toISOString(),
      netCents: r.netCents,
      chargedCents: r.chargedCents,
      paidCents: r.paidCents,
      outstandingCents: r.outstandingCents,
      lifetimeOutstandingCents: c.outstandingCents ?? 0,
      lifetimeCreditCents: c.creditCents ?? 0,
      points: points ? (c.pointsBalance ?? 0) : null,
    };
  });
  if (!money) rows = stripMoney(rows, columns);
  const tz = user.organization.timezone;
  return {
    mode: "customers",
    asOf: new Date().toISOString(),
    timezone: tz,
    currency: user.organization.currency,
    range: { from: def.from, to: def.to, basis: `Scheduled service date (${tz}), ${def.from} to ${def.to} inclusive` },
    statuses: def.statuses,
    applied: compiled.applied,
    warnings: compiled.warnings,
    notes: ["“Matched” columns cover only the service lines that match the filters in this period.", "Lifetime and points columns are current values for the customer, shown once per customer."],
    columns,
    rows,
    totals: {
      uniqueCustomers: (t.customers as number) ?? 0,
      distinctBookings: (t.bookings as number) ?? 0,
      serviceLines: (t.lines as number) ?? 0,
      netCents: mv(t.netCents),
      chargedCents: mv(t.chargedCents),
      paidCents: mv(t.paidCents),
      outstandingCents: mv(t.outstandingCents),
      pointsTotal: points ? (pointsAgg[0]?.total ?? 0) : null,
    },
    breakdowns: [],
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    moneyVisible: money,
  };
}

// ---------------------------------------------------------------------------
// Cash received
// ---------------------------------------------------------------------------

const CASH_COLUMNS: ColumnMeta[] = [
  { key: "date", label: "Transaction date", defaultVisible: true, sortable: true },
  { key: "kind", label: "Type", defaultVisible: true, sortable: true },
  { key: "receiptNumber", label: "Receipt", defaultVisible: true, sortable: true },
  { key: "customer", label: "Customer", defaultVisible: true, sortable: false },
  { key: "method", label: "Method", defaultVisible: true, sortable: false },
  { key: "category", label: "Applied to (city)", defaultVisible: true, sortable: true },
  { key: "service", label: "Service", defaultVisible: true, sortable: false },
  { key: "bookingReference", label: "Booking", defaultVisible: false, sortable: false },
  { key: "amountCents", label: "Amount", money: true, defaultVisible: true, sortable: true },
];

export async function runCashReport(user: CurrentUser, def: ReportDefinition, opts: RunOptions = {}): Promise<ReportResult> {
  if (!canMoney(user)) throw Errors.forbidden("The cash report requires permission to view financials.");
  const specs = await fieldRegistry(user, "cash");
  const compiled = compileFilters(specs, def.filters.conditions, opts.lenient);
  const orgId = new Types.ObjectId(user.organizationId);
  const tz = user.organization.timezone;
  const { start, end } = bounds(def, tz);
  const pageSize = opts.exportAll ? (opts.maxRows ?? 10_000) : Math.min(opts.pageSize ?? 25, MAX_PAGE_SIZE);
  const page = opts.exportAll ? 1 : Math.max(1, opts.page ?? 1);
  const sort = sortStage(def, { date: "date", kind: "kind", receiptNumber: "receiptNumber", category: "city", amountCents: "amountCents" }, { date: -1, _id: -1 });

  // Receipts → allocation portions + explicit unallocated remainder (original amounts; refunds are their own rows).
  const receiptParts: PipelineStage[] = [
    { $match: andOf([{ organizationId: orgId, status: "POSTED", receivedAt: { $gte: start, $lt: end } }, ...compiled.receipt]) },
    {
      $project: {
        kind: "receipt",
        date: "$receivedAt",
        customerId: 1,
        paymentId: "$_id",
        receiptNumber: 1,
        method: 1,
        parts: {
          $concatArrays: [
            { $map: { input: "$allocations", as: "a", in: { amountCents: "$$a.amountCents", bookingId: "$$a.bookingId", lineItemId: "$$a.lineItemId", serviceId: "$$a.serviceId", bookingReference: "$$a.bookingReference", city: "$$a.city", cityNormalized: "$$a.cityNormalized", serviceName: "$$a.serviceName" } } },
            [{ amountCents: { $subtract: ["$amountCents", { $sum: "$allocations.amountCents" }] }, bookingId: null, lineItemId: null, serviceId: null, bookingReference: null, city: null, cityNormalized: null, serviceName: null }],
          ],
        },
      },
    },
    { $unwind: "$parts" },
    { $match: { "parts.amountCents": { $gt: 0 } } },
  ];
  const refundParts: PipelineStage[] = [
    { $match: { organizationId: orgId, refundedAt: { $gte: start, $lt: end } } },
    { $lookup: { from: Payment.collection.name, localField: "paymentId", foreignField: "_id", as: "p", pipeline: [{ $project: { receiptNumber: 1, method: 1, status: 1 } }] } },
    { $unwind: "$p" },
    { $match: andOf([{ "p.status": "POSTED" }, ...compiled.receipt.map((f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [`p.${k}`, v])))]) },
    { $project: { kind: "refund", date: "$refundedAt", customerId: 1, paymentId: 1, receiptNumber: "$p.receiptNumber", method: "$p.method", parts: "$portions" } },
    { $unwind: "$parts" },
    { $set: { "parts.amountCents": { $multiply: ["$parts.amountCents", -1] } } },
  ];
  const stages: PipelineStage[] = [
    ...receiptParts,
    { $unionWith: { coll: "refunds", pipeline: refundParts as never } },
    // City/service/reference come from the snapshot stored with each allocation (see db:migrate for older records).
    {
      $addFields: {
        amountCents: "$parts.amountCents",
        serviceId: "$parts.serviceId",
        bookingReference: "$parts.bookingReference",
        city: { $ifNull: ["$parts.city", null] },
        cityNormalized: { $ifNull: ["$parts.cityNormalized", null] },
        service: "$parts.serviceName",
      },
    },
  ];
  if (compiled.movement.length) stages.push({ $match: andOf(compiled.movement) });
  if (compiled.customer.length) {
    stages.push(
      { $lookup: { from: Customer.collection.name, localField: "customerId", foreignField: "_id", as: "cust", pipeline: [{ $project: { searchName: 1, tags: 1, customerType: 1, contactSource: 1, outstandingCents: 1, pointsBalance: 1, customFields: 1 } }] } },
      { $unwind: "$cust" },
      { $match: andOf(compiled.customer) },
    );
  }
  const [res] = await Payment.aggregate<{
    totals: { receipts: number; refunds: number; net: number; movements: number }[];
    byCity: { _id: string | null; receipts: number; refunds: number; net: number }[];
    byService: { _id: string | null; receipts: number; refunds: number; net: number }[];
    byMethod: { _id: string; receipts: number; refunds: number; net: number }[];
    byMonth: { _id: string; receipts: number; refunds: number; net: number }[];
    rows: Record<string, unknown>[];
  }>(
    [
      ...stages,
      {
        $facet: {
          totals: [{ $group: { _id: null, receipts: { $sum: { $cond: [{ $gt: ["$amountCents", 0] }, "$amountCents", 0] } }, refunds: { $sum: { $cond: [{ $lt: ["$amountCents", 0] }, { $multiply: ["$amountCents", -1] }, 0] } }, net: { $sum: "$amountCents" }, movements: { $sum: 1 } } }],
          byCity: [{ $group: { _id: "$city", receipts: { $sum: { $cond: [{ $gt: ["$amountCents", 0] }, "$amountCents", 0] } }, refunds: { $sum: { $cond: [{ $lt: ["$amountCents", 0] }, { $multiply: ["$amountCents", -1] }, 0] } }, net: { $sum: "$amountCents" } } }, { $sort: { net: -1 } }, { $limit: 50 }],
          byService: [{ $group: { _id: "$service", receipts: { $sum: { $cond: [{ $gt: ["$amountCents", 0] }, "$amountCents", 0] } }, refunds: { $sum: { $cond: [{ $lt: ["$amountCents", 0] }, { $multiply: ["$amountCents", -1] }, 0] } }, net: { $sum: "$amountCents" } } }, { $sort: { net: -1 } }, { $limit: 50 }],
          byMethod: [{ $group: { _id: "$method", receipts: { $sum: { $cond: [{ $gt: ["$amountCents", 0] }, "$amountCents", 0] } }, refunds: { $sum: { $cond: [{ $lt: ["$amountCents", 0] }, { $multiply: ["$amountCents", -1] }, 0] } }, net: { $sum: "$amountCents" } } }, { $sort: { net: -1 } }],
          byMonth: [{ $group: { _id: { $dateToString: { format: "%Y-%m", date: "$date", timezone: tz } }, receipts: { $sum: { $cond: [{ $gt: ["$amountCents", 0] }, "$amountCents", 0] } }, refunds: { $sum: { $cond: [{ $lt: ["$amountCents", 0] }, { $multiply: ["$amountCents", -1] }, 0] } }, net: { $sum: "$amountCents" } } }, { $sort: { _id: 1 } }, { $limit: 60 }],
          rows: [{ $sort: sort }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }],
        },
      },
    ],
    { allowDiskUse: true },
  );
  const rows = res?.rows ?? [];
  const names = await resolveNames(user, [...new Set(rows.map((r) => String(r.customerId)))].map((x) => new Types.ObjectId(x)), []);
  const t = res?.totals[0];
  const bd = (rowsIn: { _id: string | null; receipts: number; refunds: number; net: number }[], label: (id: string | null) => string) =>
    rowsIn.map((x) => ({ label: label(x._id), values: { receiptsCents: x.receipts, refundsCents: x.refunds, netCents: x.net } }));
  const locationFiltered = compiled.movement.length > 0;
  return {
    mode: "cash",
    asOf: new Date().toISOString(),
    timezone: tz,
    currency: user.organization.currency,
    range: { from: def.from, to: def.to, basis: `Transaction date (receipt or refund date, ${tz}), ${def.from} to ${def.to} inclusive — not the service date` },
    statuses: null,
    applied: compiled.applied,
    warnings: [...compiled.warnings, ...(locationFiltered ? ["City/service filters only match money applied to bookings. Unallocated funds have no service location and are excluded while these filters are on."] : [])],
    notes: [
      "Receipts count on their receipt date; refunds count on their refund date, even when the original receipt was in an earlier period.",
      "City and service come only from the booking lines a receipt was applied to. Money not applied to any service appears as “Unallocated”.",
      "Reversed receipts (recorded by mistake) are excluded.",
    ],
    columns: CASH_COLUMNS,
    rows: rows.map((r) => ({
      id: `${r._id}:${String((r.parts as { lineItemId?: unknown }).lineItemId ?? "u")}:${r.kind}`,
      paymentId: String(r.paymentId),
      customerId: String(r.customerId),
      date: (r.date as Date).toISOString(),
      kind: r.kind === "receipt" ? "Receipt" : "Refund",
      receiptNumber: r.receiptNumber,
      customer: names.customers.get(String(r.customerId))?.name ?? "—",
      method: r.method,
      category: r.city ?? "Unallocated",
      service: r.service ?? (r.serviceId ? "Service" : "Unallocated"),
      bookingReference: r.bookingReference ?? "",
      amountCents: r.amountCents,
    })),
    totals: { receiptsCents: t?.receipts ?? 0, refundsCents: t?.refunds ?? 0, netCashCents: t?.net ?? 0, movements: t?.movements ?? 0 },
    breakdowns: [
      { key: "city", title: "By city (where money was applied)", rows: bd(res?.byCity ?? [], (id) => id ?? "Unallocated") },
      { key: "service", title: "By service", rows: bd(res?.byService ?? [], (id) => id ?? "Unallocated") },
      { key: "method", title: "By method", rows: bd(res?.byMethod ?? [], (id) => String(id)) },
      { key: "month", title: "By month (transaction date)", rows: bd(res?.byMonth ?? [], (id) => String(id)) },
    ],
    page,
    pageSize,
    total: t?.movements ?? 0,
    totalPages: Math.max(1, Math.ceil((t?.movements ?? 0) / pageSize)),
    moneyVisible: true,
  };
}

export async function runReport(user: CurrentUser, def: ReportDefinition, opts: RunOptions = {}): Promise<ReportResult> {
  if (!user.permissions.has("reports:read")) throw Errors.forbidden();
  await connectDb();
  if (def.mode === "service") return runServiceReport(user, def, opts);
  if (def.mode === "customers") return runCustomerReport(user, def, opts);
  return runCashReport(user, def, opts);
}
