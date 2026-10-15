import "server-only";
import { localDateKey, localTimeKey } from "@/lib/domain/zoned-time";
import type { CurrentUser } from "@/lib/auth/current-user";
import { AppError, Errors } from "@/lib/http/errors";
import { recordAudit } from "@/modules/audit/service";
import { BOOKING_STATUS_LABELS, type BookingStatus } from "@/lib/domain/constants";
import { MAX_EXPORT_ROWS, OPERATOR_LABELS, REPORT_MODE_LABELS, type ReportDefinition } from "./definition";
import { runReport } from "./engine";
import { fieldsWithOptions } from "./filters";

/**
 * Neutralises spreadsheet formula injection: cells beginning with = + - @
 * (or a tab/CR) are prefixed with an apostrophe so Excel/Sheets treat them as
 * text. Numbers are written as plain numbers.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let s = Array.isArray(value) ? value.join("; ") : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/** Cents → "1234.56" (decimal string, currency stated in the metadata block). */
function centsToDecimal(c: unknown): string {
  if (typeof c !== "number") return "";
  const neg = c < 0;
  const a = Math.abs(c);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

function describeValue(v: unknown, options?: { value: string; label: string }[]): string {
  const label = (x: unknown) => options?.find((o) => o.value === x)?.label ?? String(x);
  if (Array.isArray(v)) return v.map(label).join(" or ");
  return v === undefined ? "" : label(v);
}

/**
 * Builds a UTF-8 CSV for the full authorized result (not just the visible
 * page) using the same definition and rules as the screen. A metadata block
 * states the report, date basis, timezone, currency and filters. Audited.
 */
const DATE_COLUMNS = new Set(["serviceDate", "lastServiceDate", "date"]);

/** ISO instant → "YYYY-MM-DD HH:mm" in the organization timezone (spreadsheet-friendly). */
function localStamp(v: unknown, tz: string): unknown {
  if (typeof v !== "string") return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : `${localDateKey(d, tz)} ${localTimeKey(d, tz)}`;
}

export async function exportReportCsv(user: CurrentUser, def: ReportDefinition): Promise<{ filename: string; body: string; rows: number }> {
  if (!user.permissions.has("reports:export") || !user.permissions.has("reports:read")) throw Errors.forbidden();
  const probe = await runReport(user, def, { page: 1, pageSize: 1 });
  if (probe.total > MAX_EXPORT_ROWS) {
    throw new AppError(413, "EXPORT_TOO_LARGE", `This export would contain ${probe.total} rows; the limit is ${MAX_EXPORT_ROWS}. Narrow the date range or filters.`, { rows: probe.total, limit: MAX_EXPORT_ROWS });
  }
  const result = await runReport(user, def, { exportAll: true, maxRows: MAX_EXPORT_ROWS });
  const fields = await fieldsWithOptions(user, def.mode);
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));
  const visible = def.columns?.length ? result.columns.filter((c) => def.columns!.includes(c.key)) : result.columns;
  const cols = visible.filter((c) => !c.money || result.moneyVisible);

  const filterText = result.applied.map((a) => `${a.label} ${OPERATOR_LABELS[a.op]} ${describeValue(a.value, fieldByKey.get(a.field)?.options)}`.trim()).join("; ") || "None";
  const lines: string[] = [
    csvLine(["RealtyPacer export"]),
    csvLine(["Report", REPORT_MODE_LABELS[result.mode]]),
    csvLine(["Date basis", result.range.basis]),
    csvLine(["Timezone", result.timezone]),
    csvLine(["Currency", `${result.currency} (amounts are decimal ${result.currency}, e.g. 150.00)`]),
    csvLine(["Job statuses", result.statuses ? result.statuses.map((s) => BOOKING_STATUS_LABELS[s as BookingStatus]).join(", ") : "Not applicable"]),
    csvLine(["Filters", filterText]),
    ...(result.warnings.length ? [csvLine(["Warnings", result.warnings.join(" ")])] : []),
    csvLine(["Generated at (UTC)", result.asOf]),
    csvLine(["Rows", result.rows.length]),
    "",
    csvLine(cols.map((c) => (c.money ? `${c.label} (${result.currency})` : c.label))),
    ...result.rows.map((r) => csvLine(cols.map((c) => (c.money ? centsToDecimal(r[c.key]) : DATE_COLUMNS.has(c.key) ? localStamp(r[c.key], result.timezone) : r[c.key])))),
  ];
  await recordAudit({
    organizationId: user.organizationId,
    actorId: user.id,
    action: "report.exported",
    entityType: "report",
    metadata: { mode: def.mode, rows: result.rows.length, from: def.from, to: def.to, filters: result.applied.map((a) => a.field) },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return { filename: `realtypacer-${def.mode}-${stamp}.csv`, body: `﻿${lines.join("\r\n")}\r\n`, rows: result.rows.length };
}
