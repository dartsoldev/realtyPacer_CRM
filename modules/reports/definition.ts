/**
 * Report definitions shared by the API, CSV export, saved views and the
 * client-side filter builder. No server-only imports.
 *
 * Logic: every condition is ANDed. Several values inside one condition use
 * OR ("is any of"), e.g. City is any of [Mississauga, Toronto] AND Service is Sofa.
 */
import { z } from "zod";
import { BOOKING_STATUSES } from "@/lib/domain/constants";
import { addDaysToKey, isDateKey, todayKey } from "@/lib/domain/zoned-time";

export const REPORT_MODES = ["service", "cash", "customers"] as const;
export type ReportMode = (typeof REPORT_MODES)[number];
export const REPORT_MODE_LABELS: Record<ReportMode, string> = {
  service: "Service performance",
  cash: "Cash received",
  customers: "Customer summary",
};

export const FIELD_TYPES = ["text", "enum", "number", "money", "date", "boolean", "tags"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const OPERATORS = ["contains", "equals", "empty", "not_empty", "eq", "any_of", "gt", "lt", "between", "on", "before", "after", "is_true", "is_false", "has_any", "has_all"] as const;
export type Operator = (typeof OPERATORS)[number];

export const OPS_BY_TYPE: Record<FieldType, Operator[]> = {
  text: ["contains", "equals", "empty", "not_empty"],
  enum: ["eq", "any_of", "empty", "not_empty"],
  number: ["eq", "gt", "lt", "between", "empty", "not_empty"],
  money: ["eq", "gt", "lt", "between"],
  date: ["on", "before", "after", "between", "empty", "not_empty"],
  boolean: ["is_true", "is_false", "empty"],
  tags: ["has_any", "has_all", "empty", "not_empty"],
};

export const OPERATOR_LABELS: Record<Operator, string> = {
  contains: "contains",
  equals: "equals",
  empty: "is empty",
  not_empty: "is not empty",
  eq: "is",
  any_of: "is any of",
  gt: "greater than",
  lt: "less than",
  between: "between",
  on: "on",
  before: "before",
  after: "after",
  is_true: "is yes",
  is_false: "is no",
  has_any: "has any of",
  has_all: "has all of",
};

export const MAX_CONDITIONS = 20;
export const MAX_VALUES = 50;
export const MAX_RANGE_DAYS = 1100; // ~3 years
export const MAX_PAGE_SIZE = 100;
export const MAX_EXPORT_ROWS = 10_000;

const dateKey = z.string().refine(isDateKey, "Choose a valid date");

export const conditionSchema = z
  .object({
    /** Allowlisted field key, e.g. "city", "service", "cf:customer:cf_ab12cd34". */
    field: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_:]{0,59}$/, "Unknown field"),
    op: z.enum(OPERATORS),
    /** Validated per field type on the server; never passed to MongoDB as-is. */
    value: z.unknown().optional(),
  })
  .strict();
export type Condition = z.infer<typeof conditionSchema>;

export const DATE_PRESETS = ["this_month", "last_month", "last_30_days", "this_year", "last_year", "custom"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  last_30_days: "Last 30 days",
  this_year: "This year",
  last_year: "Last year",
  custom: "Custom dates",
};

/** Resolves a relative preset to local dates (inclusive) in the organization timezone. */
export function resolveDatePreset(preset: DatePreset, tz: string, now = new Date()): { from: string; to: string } | null {
  const today = todayKey(tz, now);
  const [y, m] = today.split("-").map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthStart = (yy: number, mm: number) => `${yy}-${pad(mm)}-01`;
  const monthEnd = (yy: number, mm: number) => addDaysToKey(mm === 12 ? `${yy + 1}-01-01` : `${yy}-${pad(mm + 1)}-01`, -1);
  switch (preset) {
    case "this_month":
      return { from: monthStart(y, m), to: monthEnd(y, m) };
    case "last_month": {
      const yy = m === 1 ? y - 1 : y;
      const mm = m === 1 ? 12 : m - 1;
      return { from: monthStart(yy, mm), to: monthEnd(yy, mm) };
    }
    case "last_30_days":
      return { from: addDaysToKey(today, -29), to: today };
    case "this_year":
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "last_year":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    default:
      return null;
  }
}

export const reportDefinitionSchema = z
  .object({
    mode: z.enum(REPORT_MODES),
    /** Relative date range for saved views; resolved to from/to when the view runs. */
    datePreset: z.enum(DATE_PRESETS).default("custom"),
    from: dateKey,
    to: dateKey,
    /** Booking statuses for service-based modes (default: completed only). */
    statuses: z.array(z.enum(BOOKING_STATUSES)).min(1).max(4).default(["COMPLETED"]),
    filters: z.object({ logic: z.literal("and").default("and"), conditions: z.array(conditionSchema).max(MAX_CONDITIONS).default([]) }).strict().default({ logic: "and", conditions: [] }),
    sort: z.object({ key: z.string().regex(/^[a-zA-Z]{1,40}$/), dir: z.enum(["asc", "desc"]) }).strict().optional(),
    columns: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_:]{0,59}$/)).max(40).optional(),
  })
  .strict()
  .refine((d) => d.from <= d.to, { message: "The start date must be on or before the end date", path: ["from"] });
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;

export type FieldMeta = {
  key: string;
  label: string;
  type: FieldType;
  ops: Operator[];
  options?: { value: string; label: string }[];
  group: "Service" | "Booking" | "Customer" | "Payment" | "Custom field";
  hint?: string;
};

export type ColumnMeta = { key: string; label: string; money?: boolean; defaultVisible: boolean; sortable: boolean };

/** URL-safe encoding of a definition (base64url JSON). */
export function encodeDefinition(d: unknown): string {
  const json = JSON.stringify(d);
  const b64 = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(json))) : Buffer.from(json, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeDefinition(s: string): unknown {
  if (s.length > 8000) throw new Error("Definition too long");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const json = typeof atob === "function" ? decodeURIComponent(escape(atob(b64))) : Buffer.from(b64, "base64").toString("utf8");
  return JSON.parse(json);
}
