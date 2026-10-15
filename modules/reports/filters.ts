import "server-only";
import { Types } from "mongoose";
import type { CurrentUser } from "@/lib/auth/current-user";
import { Booking } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { Service } from "@/lib/db/models/service";
import { BILLING_STATES, CONTACT_SOURCE_LABELS, CONTACT_SOURCES, CUSTOMER_TYPE_LABELS, CUSTOMER_TYPES, FILTERABLE_CUSTOM_FIELD_TYPES, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type CustomFieldType } from "@/lib/domain/constants";
import { escapeRegex, normalizeCity, OBJECT_ID_RE } from "@/lib/domain/normalize";
import { isDateKey } from "@/lib/domain/zoned-time";
import { AppError, Errors } from "@/lib/http/errors";
import type { Permission } from "@/lib/permissions/matrix";
import { customFieldDefsFor, type CustomFieldDef } from "@/modules/custom-fields/service";
import { MAX_VALUES, OPS_BY_TYPE, type Condition, type FieldMeta, type FieldType, type Operator, type ReportMode } from "./definition";

/**
 * Where a field is matched in the pipeline:
 *  booking  – on the booking document before line unwinding
 *  line     – on `lineItems` after $unwind (service-specific)
 *  customer – on the joined customer (`cust.*`) / customer document
 *  receipt  – on the payment document (cash report)
 *  movement – on the unwound cash movement (attributed city/service)
 */
type Level = "booking" | "line" | "customer" | "receipt" | "movement";
type ValueKind = "string" | "objectId" | "city" | "cents" | "number" | "dateKey";

export type FieldSpec = FieldMeta & { level: Level; path: string; valueKind: ValueKind; requires: Permission[]; enumValues?: readonly string[] };

export type FilterTarget = ReportMode | "customer_list";

const SERVICE_MODES: FilterTarget[] = ["service", "customers"];

function core(target: FilterTarget): FieldSpec[] {
  const fields: FieldSpec[] = [];
  const add = (f: FieldSpec, targets: FilterTarget[]) => {
    if (targets.includes(target)) fields.push(f);
  };
  // Location / service
  add({ key: "city", label: "Service city", type: "enum", ops: ["eq", "any_of"], group: "Service", level: "booking", path: "addressSnapshot.cityNormalized", valueKind: "city", requires: [], hint: "City saved on the booking" }, SERVICE_MODES);
  add({ key: "city", label: "Service city", type: "enum", ops: ["eq", "any_of"], group: "Service", level: "movement", path: "cityNormalized", valueKind: "city", requires: [], hint: "From the booking the money was applied to; unallocated funds have no city" }, ["cash"]);
  add({ key: "city", label: "City (current addresses)", type: "enum", ops: ["eq", "any_of"], group: "Customer", level: "customer", path: "addressCities", valueKind: "city", requires: ["customers:read"] }, ["customer_list"]);
  add({ key: "service", label: "Service", type: "enum", ops: ["eq", "any_of"], group: "Service", level: "line", path: "lineItems.serviceId", valueKind: "objectId", requires: [] }, SERVICE_MODES);
  add({ key: "service", label: "Service", type: "enum", ops: ["eq", "any_of"], group: "Service", level: "movement", path: "serviceId", valueKind: "objectId", requires: [] }, ["cash"]);
  add({ key: "cleaner", label: "Assigned cleaner", type: "enum", ops: ["eq", "any_of"], group: "Booking", level: "booking", path: "assignedCleanerIds", valueKind: "objectId", requires: ["cleaners:read"], hint: "Bookings are counted once even with several cleaners" }, SERVICE_MODES);
  add({ key: "billingState", label: "Billing state", type: "enum", ops: ["eq", "any_of"], group: "Booking", level: "booking", path: "billingState", valueKind: "string", requires: ["pricing:read"], enumValues: BILLING_STATES, options: [{ value: "DRAFT", label: "Draft (estimate)" }, { value: "FINALIZED", label: "Finalized (owed)" }] }, SERVICE_MODES);
  add({ key: "lineOutstanding", label: "Outstanding on service line", type: "money", ops: OPS_BY_TYPE.money, group: "Service", level: "line", path: "lineBalanceCents", valueKind: "cents", requires: ["financials:read"] }, SERVICE_MODES);
  add({ key: "method", label: "Payment method", type: "enum", ops: ["eq", "any_of"], group: "Payment", level: "receipt", path: "method", valueKind: "string", requires: ["financials:read"], enumValues: PAYMENT_METHODS, options: PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] })) }, ["cash"]);
  // Customer
  const custPath = (p: string) => (target === "customer_list" ? p : `cust.${p}`);
  const allTargets: FilterTarget[] = ["service", "customers", "cash", "customer_list"];
  add({ key: "customerName", label: "Customer name", type: "text", ops: ["contains", "equals"], group: "Customer", level: "customer", path: custPath("searchName"), valueKind: "string", requires: ["customers:read"] }, allTargets);
  add({ key: "customerTags", label: "Customer tags", type: "tags", ops: OPS_BY_TYPE.tags, group: "Customer", level: "customer", path: custPath("tags"), valueKind: "string", requires: ["customers:read"] }, allTargets);
  add({ key: "customerType", label: "Customer type", type: "enum", ops: ["eq", "any_of"], group: "Customer", level: "customer", path: custPath("customerType"), valueKind: "string", requires: ["customers:read"], enumValues: CUSTOMER_TYPES, options: CUSTOMER_TYPES.map((t) => ({ value: t, label: CUSTOMER_TYPE_LABELS[t] })) }, allTargets);
  add({ key: "contactSource", label: "Contact source", type: "enum", ops: ["eq", "any_of", "empty"], group: "Customer", level: "customer", path: custPath("contactSource"), valueKind: "string", requires: ["customers:read"], enumValues: CONTACT_SOURCES, options: CONTACT_SOURCES.map((t) => ({ value: t, label: CONTACT_SOURCE_LABELS[t] })) }, allTargets);
  add({ key: "customerOutstanding", label: "Customer outstanding (current, lifetime)", type: "money", ops: OPS_BY_TYPE.money, group: "Customer", level: "customer", path: custPath("outstandingCents"), valueKind: "cents", requires: ["financials:read"] }, allTargets);
  add({ key: "points", label: "Points balance (current)", type: "number", ops: ["eq", "gt", "lt", "between"], group: "Customer", level: "customer", path: custPath("pointsBalance"), valueKind: "number", requires: ["loyalty:read"] }, allTargets);
  return fields;
}

function cfType(t: CustomFieldType): FieldType {
  if (t === "number") return "number";
  if (t === "date") return "date";
  if (t === "boolean") return "boolean";
  if (t === "single_select") return "enum";
  if (t === "multi_select") return "tags";
  return "text";
}

function cfSpecs(defs: CustomFieldDef[], entity: "customer" | "booking", target: FilterTarget): FieldSpec[] {
  return defs
    .filter((d) => !d.archived && d.filterable && FILTERABLE_CUSTOM_FIELD_TYPES.includes(d.dataType))
    .map((d) => {
      const type = cfType(d.dataType);
      const prefix = entity === "customer" ? (target === "customer_list" ? "customFields" : "cust.customFields") : "customFields";
      return {
        key: `cf:${entity}:${d.key}`,
        label: `${d.label}${entity === "customer" ? " (customer)" : " (booking)"}`,
        type,
        ops: OPS_BY_TYPE[type],
        group: "Custom field" as const,
        level: (entity === "customer" ? "customer" : "booking") as Level,
        path: `${prefix}.${d.key}`,
        valueKind: (type === "number" ? "number" : type === "date" ? "dateKey" : "string") as ValueKind,
        requires: [entity === "customer" ? "customers:read" : "bookings:read"] as Permission[],
        enumValues: d.options.length ? d.options.map((o) => o.value) : undefined,
        options: d.options.filter((o) => !o.archived).map((o) => ({ value: o.value, label: o.label })),
      };
    });
}

/** Allowlisted fields for a report target, filtered by the viewer's permissions. */
export async function fieldRegistry(user: CurrentUser, target: FilterTarget): Promise<FieldSpec[]> {
  const specs = [...core(target)];
  if (target !== "cash") {
    if (target !== "customer_list") specs.push(...cfSpecs(await customFieldDefsFor(user.organizationId, "booking"), "booking", target));
    specs.push(...cfSpecs(await customFieldDefsFor(user.organizationId, "customer"), "customer", target));
  } else {
    specs.push(...cfSpecs(await customFieldDefsFor(user.organizationId, "customer"), "customer", target));
  }
  return specs.filter((s) => s.requires.every((p) => user.permissions.has(p)));
}

/** Registry plus option lists for the filter builder UI (bounded). */
export async function fieldsWithOptions(user: CurrentUser, target: FilterTarget): Promise<FieldMeta[]> {
  const specs = await fieldRegistry(user, target);
  const orgId = new Types.ObjectId(user.organizationId);
  const [services, cleaners, cities, tags] = await Promise.all([
    Service.find({ organizationId: orgId }).select("name").sort({ searchName: 1 }).limit(300).lean(),
    user.permissions.has("cleaners:read") ? Cleaner.find({ organizationId: orgId }).select("name").sort({ searchName: 1 }).limit(300).lean() : [],
    target === "customer_list" ? Customer.distinct("primaryCity", { organizationId: orgId }) : Booking.distinct("addressSnapshot.city", { organizationId: orgId }),
    user.permissions.has("customers:read") ? Customer.distinct("tags", { organizationId: orgId }) : [],
  ]);
  return specs.map((s) => {
    const { level: _l, path: _p, valueKind: _v, requires: _r, enumValues: _e, ...meta } = s;
    void _l; void _p; void _v; void _r; void _e;
    if (s.key === "service") return { ...meta, options: services.map((x) => ({ value: String(x._id), label: x.name })) };
    if (s.key === "cleaner") return { ...meta, options: cleaners.map((x) => ({ value: String(x._id), label: x.name })) };
    if (s.key === "city") return { ...meta, options: (cities as (string | null)[]).filter(Boolean).slice(0, 300).sort().map((c) => ({ value: c!, label: c! })) };
    if (s.key === "customerTags") return { ...meta, options: (tags as string[]).slice(0, 300).sort().map((t) => ({ value: t, label: t })) };
    return meta;
  });
}

// ---------------------------------------------------------------------------
// Compilation (validated values → MongoDB match fragments built server-side)
// ---------------------------------------------------------------------------

function bad(msg: string): never {
  throw new AppError(400, "INVALID_FILTER", msg);
}

function scalar(spec: FieldSpec, v: unknown): unknown {
  switch (spec.valueKind) {
    case "string": {
      if (typeof v !== "string" || v.length === 0 || v.length > 100) bad(`${spec.label}: invalid value.`);
      if (spec.enumValues && !spec.enumValues.includes(v as string)) bad(`${spec.label}: “${String(v).slice(0, 40)}” isn't an allowed option.`);
      return spec.key === "customerName" ? (v as string).toLowerCase() : v;
    }
    case "city":
      if (typeof v !== "string" || !v.trim() || v.length > 100) bad(`${spec.label}: invalid city.`);
      return normalizeCity(v as string);
    case "objectId":
      if (typeof v !== "string" || !OBJECT_ID_RE.test(v)) bad(`${spec.label}: invalid selection.`);
      return new Types.ObjectId(v as string);
    case "cents":
      if (typeof v !== "number" || !Number.isSafeInteger(v) || Math.abs(v) > 1e12) bad(`${spec.label}: enter an amount in cents.`);
      return v;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e12) bad(`${spec.label}: enter a number.`);
      return v;
    case "dateKey":
      if (!isDateKey(v)) bad(`${spec.label}: choose a valid date.`);
      return v;
  }
}

function list(spec: FieldSpec, v: unknown): unknown[] {
  if (!Array.isArray(v) || v.length === 0) bad(`${spec.label}: choose at least one value.`);
  if ((v as unknown[]).length > MAX_VALUES) bad(`${spec.label}: at most ${MAX_VALUES} values.`);
  return (v as unknown[]).map((x) => scalar(spec, x));
}

function pair(spec: FieldSpec, v: unknown): [unknown, unknown] {
  if (!Array.isArray(v) || v.length !== 2) bad(`${spec.label}: enter a from and to value.`);
  return [scalar(spec, (v as unknown[])[0]), scalar(spec, (v as unknown[])[1])];
}

/** One condition → a match fragment on the field's path (never a client-supplied operator). */
export function compileCondition(spec: FieldSpec, op: Operator, value: unknown): Record<string, unknown> {
  if (!spec.ops.includes(op)) bad(`“${op}” can't be used with ${spec.label}.`);
  const p = spec.path;
  switch (op) {
    case "contains":
      return { [p]: { $regex: escapeRegex(String(scalar(spec, value))), $options: "i" } };
    case "equals":
      return { [p]: { $regex: `^${escapeRegex(String(scalar(spec, value)))}$`, $options: "i" } };
    case "empty":
      return { [p]: { $in: [null, "", []] } };
    case "not_empty":
      return { [p]: { $nin: [null, "", []], $exists: true } };
    case "eq":
    case "on":
      return { [p]: scalar(spec, value) };
    case "any_of":
    case "has_any":
      return { [p]: { $in: list(spec, value) } };
    case "has_all":
      return { [p]: { $all: list(spec, value) } };
    case "gt":
    case "after":
      return { [p]: { $gt: scalar(spec, value) } };
    case "lt":
    case "before":
      return { [p]: { $lt: scalar(spec, value) } };
    case "between": {
      const [a, b] = pair(spec, value);
      if ((a as number | string) > (b as number | string)) bad(`${spec.label}: the first value must be the smaller one.`);
      return { [p]: { $gte: a, $lte: b } };
    }
    case "is_true":
      return { [p]: true };
    case "is_false":
      return { [p]: false };
  }
  return bad("Unsupported operator.");
}

export type CompiledFilters = Record<Level, Record<string, unknown>[]> & { warnings: string[]; applied: { field: string; label: string; op: Operator; value: unknown }[] };

/**
 * Compiles a definition's conditions against the allowlist. Strict mode
 * rejects unknown/unauthorized fields (API); lenient mode (saved views)
 * drops them with an explanation so an archived custom field doesn't break a view.
 */
export function compileFilters(specs: FieldSpec[], conditions: Condition[], lenient = false): CompiledFilters {
  const byKey = new Map(specs.map((s) => [s.key, s]));
  const out: CompiledFilters = { booking: [], line: [], customer: [], receipt: [], movement: [], warnings: [], applied: [] };
  for (const c of conditions) {
    const spec = byKey.get(c.field);
    if (!spec) {
      const msg = c.field.startsWith("cf:")
        ? "A filter uses a custom field that was archived, made non-filterable or that you can't access, so it was ignored."
        : `The filter “${c.field}” isn't available for this report or your role, so it was ignored.`;
      if (lenient) {
        out.warnings.push(msg);
        continue;
      }
      throw Errors.validation(msg);
    }
    try {
      out[spec.level].push(compileCondition(spec, c.op, c.value));
      out.applied.push({ field: spec.key, label: spec.label, op: c.op, value: c.value });
    } catch (err) {
      if (lenient && err instanceof AppError) {
        out.warnings.push(`${err.message} The filter was ignored.`);
        continue;
      }
      throw err;
    }
  }
  return out;
}

export function andOf(frags: Record<string, unknown>[]): Record<string, unknown> {
  return frags.length === 0 ? {} : frags.length === 1 ? frags[0]! : { $and: frags };
}
