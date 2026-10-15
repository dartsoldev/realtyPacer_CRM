"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookmarkPlus, ChevronLeft, ChevronRight, Columns3, Download, Filter, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { cn } from "@/components/ui/cn";
import { apiRequest } from "@/lib/client/api";
import { BOOKING_STATUS_LABELS, BOOKING_STATUSES, type BookingStatus } from "@/lib/domain/constants";
import { formatCents, parseAmountToCents } from "@/lib/domain/money";
import { formatDate, formatDateTime } from "@/lib/domain/time";
import {
  DATE_PRESET_LABELS,
  DATE_PRESETS,
  encodeDefinition,
  MAX_CONDITIONS,
  OPERATOR_LABELS,
  REPORT_MODE_LABELS,
  resolveDatePreset,
  type Condition,
  type DatePreset,
  type FieldMeta,
  type Operator,
  type ReportDefinition,
  type ReportMode,
} from "@/modules/reports/definition";
import type { ReportResult } from "@/modules/reports/engine";
import type { ViewDTO } from "@/modules/reports/views";

const BarChart = dynamic(() => import("./bar-chart"), { ssr: false, loading: () => <p className="text-xs text-muted">Loading chart…</p> });

const NO_VALUE_OPS: Operator[] = ["empty", "not_empty", "is_true", "is_false"];
const LIST_OPS: Operator[] = ["any_of", "has_any", "has_all"];
const PAGE_SIZE = 25;

type Props = {
  modes: ReportMode[];
  initial: ReportDefinition;
  timezone: string;
  currency: string;
  canExport: boolean;
  canShare: boolean;
};

export function describeValue(field: FieldMeta | undefined, op: Operator, value: unknown, currency: string): string {
  if (NO_VALUE_OPS.includes(op)) return "";
  const one = (v: unknown) => {
    if (field?.type === "money" && typeof v === "number") return formatCents(v, currency);
    return field?.options?.find((o) => o.value === v)?.label ?? String(v);
  };
  if (Array.isArray(value)) return op === "between" ? `${one(value[0])} and ${one(value[1])}` : value.map(one).join(" or ");
  return one(value);
}

/** Editor for one new condition: field → operator → typed value. */
export function ConditionEditor({ fields, currency, onAdd, onCancel }: { fields: FieldMeta[]; currency: string; onAdd: (c: Condition) => void; onCancel: () => void }) {
  const [fieldKey, setFieldKey] = useState(fields[0]?.key ?? "");
  const field = fields.find((f) => f.key === fieldKey);
  const [op, setOp] = useState<Operator>((field?.ops.includes("any_of") ? "any_of" : field?.ops[0]) ?? "eq");
  const [text, setText] = useState("");
  const [text2, setText2] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function changeField(k: string) {
    setFieldKey(k);
    const f = fields.find((x) => x.key === k);
    setOp((f?.ops.includes("any_of") ? "any_of" : f?.ops[0]) ?? "eq");
    setText("");
    setText2("");
    setPicked([]);
    setError(null);
  }
  function parse(raw: string): unknown {
    if (!field) return null;
    if (field.type === "money") return parseAmountToCents(raw);
    if (field.type === "number") return raw.trim() === "" || !Number.isFinite(Number(raw)) ? null : Number(raw);
    return raw.trim() || null;
  }
  function add() {
    if (!field) return;
    let value: unknown;
    if (NO_VALUE_OPS.includes(op)) value = undefined;
    else if (LIST_OPS.includes(op)) {
      value = field.options ? picked : text.split(",").map((s) => s.trim()).filter(Boolean);
      if ((value as unknown[]).length === 0) return setError("Choose at least one value.");
    } else if (op === "between") {
      const a = parse(text);
      const b = parse(text2);
      if (a === null || b === null) return setError("Enter both values.");
      value = [a, b];
    } else if (field.options && (op === "eq")) {
      if (!picked[0]) return setError("Choose a value.");
      value = picked[0];
    } else {
      value = parse(text);
      if (value === null) return setError(field.type === "money" ? "Enter an amount like 25.00." : "Enter a value.");
    }
    onAdd({ field: field.key, op, value });
  }

  const inputType = field?.type === "date" ? "date" : field?.type === "number" || field?.type === "money" ? "text" : "text";
  const groups = [...new Set(fields.map((f) => f.group))];
  return (
    <div className="space-y-3 rounded-lg border border-line bg-canvas p-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <Field label="Field">
          {(p) => (
            <Select {...p} data-autofocus value={fieldKey} onChange={(e) => changeField(e.target.value)}>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {fields.filter((f) => f.group === g).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                </optgroup>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Condition">
          {(p) => (
            <Select {...p} value={op} onChange={(e) => { setOp(e.target.value as Operator); setPicked([]); setError(null); }}>
              {field?.ops.map((o) => <option key={o} value={o}>{OPERATOR_LABELS[o]}</option>)}
            </Select>
          )}
        </Field>
      </div>
      {field?.hint ? <p className="text-xs text-muted">{field.hint}</p> : null}
      {field && !NO_VALUE_OPS.includes(op) ? (
        field.options && (LIST_OPS.includes(op) || op === "eq") ? (
          <fieldset>
            <legend className="mb-1 text-sm font-medium">{LIST_OPS.includes(op) ? "Values (any selected value matches)" : "Value"}</legend>
            {field.options.length === 0 ? <p className="text-sm text-muted">No values recorded yet.</p> : null}
            <div className="flex max-h-48 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
              {field.options.map((o) => (
                <label key={o.value} className="inline-flex items-center gap-2 text-sm">
                  <input
                    type={LIST_OPS.includes(op) ? "checkbox" : "radio"}
                    name="cond-value"
                    className="size-4 accent-brand"
                    checked={picked.includes(o.value)}
                    onChange={(e) => setPicked(LIST_OPS.includes(op) ? (e.target.checked ? [...picked, o.value] : picked.filter((x) => x !== o.value)) : [o.value])}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        ) : op === "between" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From">{(p) => <Input {...p} type={inputType} inputMode={field.type === "money" || field.type === "number" ? "decimal" : undefined} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
            <Field label="To">{(p) => <Input {...p} type={inputType} inputMode={field.type === "money" || field.type === "number" ? "decimal" : undefined} value={text2} onChange={(e) => setText2(e.target.value)} />}</Field>
          </div>
        ) : (
          <Field label={LIST_OPS.includes(op) ? "Values (comma-separated)" : field.type === "money" ? `Amount (${currency})` : "Value"}>
            {(p) => <Input {...p} type={inputType} inputMode={field.type === "money" || field.type === "number" ? "decimal" : undefined} value={text} onChange={(e) => setText(e.target.value)} maxLength={100} />}
          </Field>
        )
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" onClick={add}>Add condition</Button>
      </div>
    </div>
  );
}

function formatCell(key: string, v: unknown, money: boolean, currency: string, tz: string, field?: FieldMeta): React.ReactNode {
  if (v === null || v === undefined || v === "") return <span className="text-muted">—</span>;
  if (money && typeof v === "number") return formatCents(v, currency);
  if ((key === "serviceDate" || key === "lastServiceDate") && typeof v === "string") return formatDate(v, tz);
  if (key === "date" && typeof v === "string") return formatDateTime(v, tz);
  if (key === "status" && typeof v === "string") return BOOKING_STATUS_LABELS[v as BookingStatus] ?? v;
  if (key === "billingState") return v === "FINALIZED" ? "Finalized" : "Draft";
  if (field?.options) {
    const label = (x: unknown) => field.options!.find((o) => o.value === x)?.label ?? String(x);
    return Array.isArray(v) ? v.map(label).join(", ") : label(v);
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

const TOTAL_LABELS: Record<string, string> = {
  uniqueCustomers: "Unique customers",
  distinctBookings: "Bookings",
  serviceLines: "Service lines",
  customers: "Customers",
  grossCents: "Gross service value",
  discountCents: "Discounts",
  netCents: "Net service value",
  taxCents: "Tax",
  chargedCents: "Charged (finalized)",
  estimateCents: "Draft estimates",
  paidCents: "Net paid toward these lines",
  outstandingCents: "Outstanding on these lines",
  receiptsCents: "Receipts",
  refundsCents: "Refunds",
  netCashCents: "Net cash received",
  movements: "Movements",
  pointsTotal: "Points (current)",
};

const BREAKDOWN_COLUMN: Record<string, string> = { bookings: "Bookings", lines: "Lines", netCents: "Net", chargedCents: "Charged", paidCents: "Paid", outstandingCents: "Outstanding", receiptsCents: "Receipts", refundsCents: "Refunds" };
const BREAKDOWN_ROW: Record<string, string> = { city: "City", service: "Service", month: "Month", customer: "Customer", cleaner: "Cleaner", method: "Method" };
const NOWRAP = new Set(["reference", "receiptNumber", "serviceDate", "date", "lastServiceDate", "bookingReference"]);

export function ReportBuilder({ modes, initial, timezone, currency, canExport, canShare }: Props) {
  const pathname = usePathname();
  const [def, setDef] = useState<ReportDefinition>(initial);
  const [page, setPage] = useState(1);
  const [fields, setFields] = useState<FieldMeta[]>([]);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [views, setViews] = useState<ViewDTO[]>([]);
  const [activeView, setActiveView] = useState<ViewDTO | null>(null);
  const [lenient, setLenient] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showCharts, setShowCharts] = useState(false);
  const runId = useRef(0);

  // Field catalog for the current mode (already filtered by the viewer's permissions).
  useEffect(() => {
    let cancelled = false;
    void apiRequest<{ fields: FieldMeta[] }>(`/api/v1/reports/fields?mode=${def.mode}`).then((r) => {
      if (!cancelled && r.ok) setFields(r.data.fields);
    });
    return () => {
      cancelled = true;
    };
  }, [def.mode]);

  const loadViews = useCallback(() => {
    void apiRequest<{ items: ViewDTO[] }>(`/api/v1/views?reportType=${def.mode}`).then((r) => r.ok && setViews(r.data.items));
  }, [def.mode]);
  useEffect(() => loadViews(), [loadViews]);

  // Run (debounced). POST keeps filter definitions out of URLs and logs.
  useEffect(() => {
    const id = ++runId.current;
    const t = setTimeout(() => {
      setLoading(true);
      void apiRequest<ReportResult>("/api/v1/reports/run", { method: "POST", body: { definition: def, page, pageSize: PAGE_SIZE, lenient } }).then((r) => {
        if (id !== runId.current) return;
        setLoading(false);
        if (r.ok) {
          setResult(r.data);
          setError(null);
        } else setError(r.message);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [def, page, lenient]);

  // Keep a shareable link to the current report (the link carries no access).
  // (Native history update: no server round-trip; Next keeps it in sync with useSearchParams.)
  useEffect(() => {
    window.history.replaceState(null, "", `${pathname}?d=${encodeDefinition(def)}`);
  }, [def, pathname]);

  const update = (patch: Partial<ReportDefinition>) => {
    setDef((d) => ({ ...d, ...patch }));
    setPage(1);
  };
  const setPreset = (p: DatePreset) => {
    const r = resolveDatePreset(p, timezone);
    update(r ? { datePreset: p, ...r } : { datePreset: p });
  };
  const conditions = def.filters.conditions;
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const columns = result?.columns ?? [];
  const visible = new Set(def.columns ?? columns.filter((c) => c.defaultVisible).map((c) => c.key));
  const shownColumns = columns.filter((c) => visible.has(c.key) && (!c.money || result?.moneyVisible));

  function toggleSort(key: string) {
    const cur = def.sort;
    update({ sort: { key, dir: cur?.key === key && cur.dir === "desc" ? "asc" : "desc" } });
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const res = await fetch("/api/v1/reports/export", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ definition: def }) });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(j?.error?.message ?? "Export failed.");
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? "report.csv";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  function loadView(v: ViewDTO) {
    setActiveView(v);
    setLenient(true); // archived/removed fields become warnings instead of errors
    setDef(v.definition);
    setPage(1);
  }

  const money = (v: unknown) => (typeof v === "number" ? formatCents(v, currency) : "—");
  const isMoneyKey = (k: string) => k.endsWith("Cents");

  return (
    <div className="space-y-4">
      {/* Mode */}
      <div role="tablist" aria-label="Report type" className="flex flex-wrap gap-1 border-b border-line">
        {modes.map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={def.mode === m}
            onClick={() => {
              setActiveView(null);
              setLenient(false);
              update({ mode: m, filters: { logic: "and", conditions: [] }, sort: undefined, columns: undefined });
            }}
            className={cn("whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", def.mode === m ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink")}
          >
            {REPORT_MODE_LABELS[m]}
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_18rem]">
        <div className="min-w-0 space-y-4">
          {/* Date + statuses */}
          <section aria-label="Date range" className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4">
            <label className="text-sm">
              <span className="mb-1 block font-medium">{def.mode === "cash" ? "Transaction dates" : "Service dates"}</span>
              <select value={def.datePreset} onChange={(e) => setPreset(e.target.value as DatePreset)} className="h-10 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
                {DATE_PRESETS.map((p) => <option key={p} value={p}>{DATE_PRESET_LABELS[p]}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">From</span>
              <input type="date" value={def.from} onChange={(e) => e.target.value && update({ from: e.target.value, datePreset: "custom" })} className="h-10 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">To</span>
              <input type="date" value={def.to} onChange={(e) => e.target.value && update({ to: e.target.value, datePreset: "custom" })} className="h-10 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm" />
            </label>
            {def.mode !== "cash" ? (
              <fieldset className="text-sm">
                <legend className="mb-1 font-medium">Job status</legend>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {BOOKING_STATUSES.map((s) => (
                    <label key={s} className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        className="size-4 accent-brand"
                        checked={def.statuses.includes(s)}
                        onChange={(e) => {
                          const next = e.target.checked ? [...def.statuses, s] : def.statuses.filter((x) => x !== s);
                          if (next.length) update({ statuses: next });
                        }}
                      />
                      {BOOKING_STATUS_LABELS[s]}
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </section>

          {/* Filters */}
          <section aria-labelledby="filters-h" className="space-y-3 rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="filters-h" className="flex items-center gap-2 text-sm font-semibold">
                <Filter className="size-4" aria-hidden /> Filters <span className="font-normal text-muted">— all conditions must match</span>
              </h2>
              <div className="flex gap-2">
                {conditions.length ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => update({ filters: { logic: "and", conditions: [] } })}>
                    <RotateCcw className="size-4" aria-hidden /> Clear all
                  </Button>
                ) : null}
                {!adding && conditions.length < MAX_CONDITIONS ? (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setAdding(true)} disabled={fields.length === 0}>
                    <Plus className="size-4" aria-hidden /> Add condition
                  </Button>
                ) : null}
              </div>
            </div>
            {conditions.length ? (
              <ul className="flex flex-wrap gap-2" aria-label="Active conditions">
                {conditions.map((c, i) => {
                  const f = fieldByKey.get(c.field);
                  const text = `${f?.label ?? "Unavailable field"} ${OPERATOR_LABELS[c.op]} ${describeValue(f, c.op, c.value, currency)}`.trim();
                  return (
                    <li key={i}>
                      {i > 0 ? <span className="mr-2 text-xs font-semibold text-muted">AND</span> : null}
                      <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium", f ? "bg-brand-soft text-brand" : "bg-pending-soft text-pending")}>
                        {text}
                        <button type="button" onClick={() => update({ filters: { logic: "and", conditions: conditions.filter((_, j) => j !== i) } })} className="rounded-full p-0.5 hover:bg-white/60" aria-label={`Remove condition: ${text}`}>
                          <X className="size-3" aria-hidden />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted">No filters. Example: City is any of Mississauga, Toronto AND Service is Sofa cleaning.</p>
            )}
            {adding ? (
              <ConditionEditor
                fields={fields}
                currency={currency}
                onCancel={() => setAdding(false)}
                onAdd={(c) => {
                  update({ filters: { logic: "and", conditions: [...conditions, c] } });
                  setAdding(false);
                }}
              />
            ) : null}
          </section>
        </div>

        {/* Saved views */}
        <aside aria-labelledby="views-h" className="space-y-3 rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 id="views-h" className="text-sm font-semibold">Saved views</h2>
            <Button type="button" variant="secondary" size="sm" onClick={() => setSaveOpen(true)}>
              <BookmarkPlus className="size-4" aria-hidden /> Save
            </Button>
          </div>
          {views.length === 0 ? <p className="text-sm text-muted">No saved views for this report yet.</p> : null}
          <ul className="space-y-1">
            {views.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => loadView(v)} className={cn("min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm hover:bg-canvas", activeView?.id === v.id && "bg-brand-soft text-brand")}>
                  {v.name}
                  <span className="block text-xs text-muted">{v.visibility === "shared" ? `Shared${v.mine ? "" : ` by ${v.owner}`}` : "Private"}</span>
                </button>
                {v.mine ? (
                  <button
                    type="button"
                    aria-label={`Delete view ${v.name}`}
                    className="rounded-md p-1.5 text-muted hover:bg-canvas hover:text-danger"
                    onClick={async () => {
                      if (!window.confirm(`Delete the view “${v.name}”?`)) return;
                      const r = await apiRequest(`/api/v1/views/${v.id}`, { method: "DELETE" });
                      if (r.ok) {
                        if (activeView?.id === v.id) setActiveView(null);
                        loadViews();
                      }
                    }}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">Views store filters only. Anyone opening a view sees only what their own permissions allow.</p>
        </aside>
      </div>

      {error ? <Alert tone="danger" title="Report could not run">{error}</Alert> : null}
      {result?.warnings.length ? (
        <Alert tone="pending" title="Some saved conditions were skipped">
          <ul className="list-disc pl-5">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </Alert>
      ) : null}

      {result ? (
        <section aria-labelledby="results-h" aria-busy={loading} className={cn("space-y-4", loading && "opacity-70")}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="results-h" className="text-base font-semibold">{REPORT_MODE_LABELS[result.mode]}</h2>
              <p className="text-xs text-muted">
                {result.range.basis} · as of {formatDateTime(result.asOf, result.timezone)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setColumnsOpen(true)}>
                <Columns3 className="size-4" aria-hidden /> Columns
              </Button>
              {canExport ? (
                <Button type="button" variant="secondary" size="sm" loading={exporting} onClick={() => void exportCsv()}>
                  <Download className="size-4" aria-hidden /> Export CSV
                </Button>
              ) : null}
            </div>
          </div>

          {!result.moneyVisible ? <Alert tone="info" title="Amounts hidden">Your access doesn’t include financial amounts, so money columns and totals are not shown.</Alert> : null}

          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Object.entries(result.totals)
              .filter(([, v]) => v !== null)
              .map(([k, v]) => (
                <div key={k} className="rounded-xl border border-line bg-surface p-3">
                  <dt className="text-xs font-medium text-muted">{TOTAL_LABELS[k] ?? k}</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">{isMoneyKey(k) ? money(v) : String(v)}</dd>
                </div>
              ))}
          </dl>
          {result.unitsByLabel?.length ? (
            <p className="text-sm text-muted">Quantities: {result.unitsByLabel.map((u) => `${u.quantity} ${u.unit}${u.quantity === 1 ? "" : "s"}`).join(" · ")}</p>
          ) : null}

          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            {result.rows.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-muted">Nothing matches these filters and dates.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[48rem] text-sm">
                  <caption className="sr-only">Report results, page {result.page} of {result.totalPages}</caption>
                  <thead className="bg-canvas text-left text-xs text-muted">
                    <tr>
                      {shownColumns.map((c) => (
                        <th key={c.key} scope="col" className={cn("px-3 py-2 font-medium", c.money && "text-right")} aria-sort={def.sort?.key === c.key ? (def.sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                          {c.sortable ? (
                            <button type="button" onClick={() => toggleSort(c.key)} className="underline-offset-4 hover:underline">
                              {c.label} {def.sort?.key === c.key ? (def.sort.dir === "asc" ? "↑" : "↓") : ""}
                            </button>
                          ) : (
                            c.label
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {result.rows.map((r) => (
                      <tr key={String(r.id)}>
                        {shownColumns.map((c) => {
                          const v = r[c.key];
                          const cell = formatCell(c.key, v, Boolean(c.money), result.currency, result.timezone, fieldByKey.get(c.key));
                          const href =
                            c.key === "reference" && r.bookingId ? `/dashboard/bookings/${r.bookingId}` : c.key === "customer" && r.customerId ? `/dashboard/customers/${r.customerId}` : c.key === "receiptNumber" && r.paymentId ? `/dashboard/payments/${r.paymentId}` : null;
                          return (
                            <td key={c.key} className={cn("px-3 py-2", c.money && "text-right tabular-nums", NOWRAP.has(c.key) && "whitespace-nowrap")}>
                              {href ? <Link href={href} className="text-brand underline-offset-4 hover:underline">{cell}</Link> : cell}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <nav aria-label="Report pages" className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
              <p>Page {result.page} of {result.totalPages} · {result.total} rows</p>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="size-4" aria-hidden /> Previous
                </Button>
                <Button type="button" variant="secondary" size="sm" disabled={page >= result.totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next <ChevronRight className="size-4" aria-hidden />
                </Button>
              </div>
            </nav>
          </div>

          {result.notes.length ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted">{result.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          ) : null}

          {result.breakdowns.length ? (
            <section aria-labelledby="bd-h" className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 id="bd-h" className="text-base font-semibold">Breakdowns</h2>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-brand" checked={showCharts} onChange={(e) => setShowCharts(e.target.checked)} /> Show charts
                </label>
              </div>
              <div className="grid gap-4 2xl:grid-cols-2">
                {result.breakdowns.map((b) => {
                  const keys = [...new Set(b.rows.flatMap((r) => Object.keys(r.values)))].filter((k) => b.rows.some((r) => r.values[k] !== null));
                  const chartKey = keys.find((k) => k === "netCents" || k === "netCashCents") ?? keys.find(isMoneyKey) ?? keys[0];
                  return (
                    <div key={b.key} className="rounded-xl border border-line bg-surface p-4">
                      <h3 className="text-sm font-semibold">{b.title}</h3>
                      {b.note ? <p className="text-xs text-muted">{b.note}</p> : null}
                      {b.rows.length === 0 ? (
                        <p className="mt-2 text-sm text-muted">No data.</p>
                      ) : (
                        <>
                          {showCharts && chartKey ? (
                            <div className="my-3">
                              <BarChart rows={b.rows.map((r) => ({ label: r.label, value: r.values[chartKey] ?? 0 }))} format={(v) => (isMoneyKey(chartKey) ? formatCents(v, currency) : String(v))} />
                            </div>
                          ) : null}
                          <div className="mt-2 overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead className="text-left text-xs text-muted">
                                <tr>
                                  <th scope="col" className="py-1 pr-3 font-medium">{BREAKDOWN_ROW[b.key] ?? "Group"}</th>
                                  {keys.map((k) => <th key={k} scope="col" className="py-1 pl-3 text-right font-medium">{BREAKDOWN_COLUMN[k] ?? TOTAL_LABELS[k] ?? k}</th>)}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-line">
                                {b.rows.map((r) => (
                                  <tr key={r.label}>
                                    <th scope="row" className="py-1 pr-3 text-left font-normal">{r.label}</th>
                                    {keys.map((k) => <td key={k} className="py-1 pl-3 text-right tabular-nums">{isMoneyKey(k) ? money(r.values[k]) : (r.values[k] ?? "—")}</td>)}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </section>
      ) : loading ? (
        <p className="text-sm text-muted">Running report…</p>
      ) : null}

      <Modal title="Choose columns" open={columnsOpen} onClose={() => setColumnsOpen(false)}>
        <fieldset className="space-y-2">
          <legend className="sr-only">Visible columns</legend>
          {columns.filter((c) => !c.money || result?.moneyVisible).map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-brand"
                checked={visible.has(c.key)}
                onChange={(e) => {
                  const next = new Set(visible);
                  if (e.target.checked) next.add(c.key);
                  else next.delete(c.key);
                  if (next.size) update({ columns: columns.map((x) => x.key).filter((k) => next.has(k)) });
                }}
              />
              {c.label}
            </label>
          ))}
        </fieldset>
        <div className="mt-4 flex justify-between">
          <Button type="button" variant="ghost" size="sm" onClick={() => update({ columns: undefined })}>Reset to default</Button>
          <Button type="button" size="sm" onClick={() => setColumnsOpen(false)}>Done</Button>
        </div>
      </Modal>

      <SaveViewDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        def={def}
        active={activeView}
        canShare={canShare}
        onSaved={() => {
          setSaveOpen(false);
          loadViews();
        }}
      />
    </div>
  );
}

function SaveViewDialog({ open, onClose, def, active, canShare, onSaved }: { open: boolean; onClose: () => void; def: ReportDefinition; active: ViewDTO | null; canShare: boolean; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"private" | "shared">("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canUpdate = Boolean(active && (active.mine || (active.visibility === "shared" && canShare)));
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the form each time the dialog opens
    setName(active?.name ?? "");
    setVisibility(active?.visibility ?? "private");
    setError(null);
  }, [open, active]);
  async function save(asNew: boolean) {
    setBusy(true);
    setError(null);
    const res = asNew || !active ? await apiRequest("/api/v1/views", { method: "POST", body: { name, visibility, definition: def } }) : await apiRequest(`/api/v1/views/${active.id}`, { method: "PATCH", body: { name, visibility, definition: def } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    onSaved();
  }
  return (
    <Modal title="Save view" open={open} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(!canUpdate); }}>
        <Field label="Name" required>
          {(p) => <Input {...p} data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />}
        </Field>
        <Field label="Who can use it" hint={canShare ? "Shared views appear for everyone who can open reports; each person still sees only what they're allowed to." : "You can save private views. Sharing needs the “share views” permission."}>
          {(p) => (
            <Select {...p} value={visibility} onChange={(e) => setVisibility(e.target.value as "private" | "shared")} disabled={!canShare}>
              <option value="private">Only me</option>
              <option value="shared">Shared with the team</option>
            </Select>
          )}
        </Field>
        <p className="text-xs text-muted">
          {def.datePreset !== "custom" ? <Badge tone="info">{DATE_PRESET_LABELS[def.datePreset]}</Badge> : null} {def.datePreset !== "custom" ? "The date range moves with the calendar each time the view is opened." : "The view keeps these exact dates."}
        </p>
        {error ? <Alert tone="danger" title="Not saved">{error}</Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          {canUpdate ? <Button type="button" variant="secondary" loading={busy} onClick={() => void save(true)} disabled={!name.trim()}>Save as new</Button> : null}
          <Button type="submit" loading={busy} disabled={!name.trim()}>{canUpdate ? `Update “${active!.name}”` : "Save view"}</Button>
        </div>
      </form>
    </Modal>
  );
}
