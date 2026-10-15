"use client";

import { Columns3, Filter, Plus, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Modal } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/client/api";
import { BOOKING_STATUS_LABELS } from "@/lib/domain/constants";
import { formatCents } from "@/lib/domain/money";
import { encodeDefinition, OPERATOR_LABELS, type Condition, type FieldMeta } from "@/modules/reports/definition";
import type { CustomerFilterResult } from "@/modules/reports/customer-filter";
import { ConditionEditor, describeValue } from "./report-builder";

type Sort = "recent" | "name" | "paid" | "services";

/**
 * Excel-style customer & service filter: Add filter / remove / Clear filters /
 * Select columns, total cards above the table. Filters combine with AND.
 */
export function CustomerFilter({ initialConditions, initialColumns, timezone, currency }: { initialConditions: Condition[]; initialColumns: string[]; timezone: string; currency: string }) {
  const pathname = usePathname();
  const [conditions, setConditions] = useState<Condition[]>(initialConditions);
  const [columns, setColumns] = useState<string[]>(initialColumns);
  const [sort, setSort] = useState<Sort>("recent");
  const [page, setPage] = useState(1);
  const [fields, setFields] = useState<FieldMeta[]>([]);
  const [result, setResult] = useState<CustomerFilterResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);

  useEffect(() => {
    void apiRequest<{ fields: FieldMeta[] }>("/api/v1/reports/fields?mode=service_filter").then((r) => r.ok && setFields(r.data.fields));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag for the server query
    setLoading(true);
    void apiRequest<CustomerFilterResult>("/api/v1/reports/customer-services", { method: "POST", body: { conditions, columns, sort, page }, signal: controller.signal }).then((r) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (r.ok) {
        setResult(r.data);
        setError(null);
      } else setError(r.message);
    });
    // Shareable link with the current filters (settings only — access is re-checked).
    const sp = new URLSearchParams();
    if (conditions.length) sp.set("f", encodeDefinition(conditions));
    sp.set("c", columns.join(","));
    window.history.replaceState(null, "", `${pathname}?${sp}`);
    return () => controller.abort();
  }, [conditions, columns, sort, page, pathname]);

  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const update = (next: Condition[]) => {
    setConditions(next);
    setPage(1);
  };
  const money = (v: number | null | undefined) => (typeof v === "number" ? formatCents(v, currency) : "—");
  const fmtDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, dateStyle: "medium" }).format(new Date(iso));
  const t = result?.totals;
  const cell = (key: string, v: unknown) => {
    if (v === null || v === undefined || v === "") return <span className="text-muted">—</span>;
    if (Array.isArray(v)) {
      const opts = result?.customFieldOptions[key]?.options;
      return v.map((x) => opts?.find((o) => o.value === x)?.label ?? String(x)).join(", ") || <span className="text-muted">—</span>;
    }
    if (typeof v === "boolean") return v ? "Yes" : "No";
    const opts = result?.customFieldOptions[key]?.options;
    return opts?.find((o) => o.value === v)?.label ?? String(v);
  };

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-live="polite">
        {[
          ["Matching customers", t ? String(t.customers) : "…"],
          ["Matching bookings", t ? String(t.bookings) : "…"],
          ["Matching services", t ? String(t.services) : "…"],
          ...(result?.moneyVisible !== false ? [["Paid toward these services", t ? money(t.paidCents) : "…"]] : []),
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-surface p-4">
            <dt className="text-xs font-medium text-muted">{label}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <section aria-label="Filters" className="space-y-3 rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="size-4 text-muted" aria-hidden />
          {conditions.length === 0 ? <span className="text-sm text-muted">No filters — showing every completed service. Try City is Mississauga AND Service is Sofa cleaning.</span> : null}
          {conditions.map((c, i) => {
            const f = fieldByKey.get(c.field);
            const text = `${f?.label ?? "Filter"} ${OPERATOR_LABELS[c.op]} ${describeValue(f, c.op, c.value, currency)}`.trim();
            return (
              <span key={i} className="inline-flex items-center gap-1">
                {i > 0 ? <span className="text-xs font-semibold text-muted">AND</span> : null}
                <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand">
                  {text}
                  <button type="button" onClick={() => update(conditions.filter((_, j) => j !== i))} className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full hover:bg-white/60" aria-label={`Remove filter: ${text}`}>
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              </span>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2">
          {!adding ? (
            <Button size="sm" onClick={() => setAdding(true)} disabled={fields.length === 0}>
              <Plus className="size-4" aria-hidden /> Add filter
            </Button>
          ) : null}
          {conditions.length ? (
            <Button size="sm" variant="secondary" onClick={() => update([])}>
              <RotateCcw className="size-4" aria-hidden /> Clear filters
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" onClick={() => setColumnsOpen(true)}>
            <Columns3 className="size-4" aria-hidden /> Select columns
          </Button>
          <label className="ml-auto inline-flex items-center gap-2 text-sm">
            <span className="text-muted">Sort</span>
            <select value={sort} onChange={(e) => { setSort(e.target.value as Sort); setPage(1); }} className="h-9 rounded-lg border border-line bg-surface px-2 text-base sm:text-sm">
              <option value="recent">Most recent service</option>
              <option value="name">Customer name</option>
              <option value="services">Most services</option>
              {result?.moneyVisible !== false ? <option value="paid">Most paid</option> : null}
            </select>
          </label>
        </div>
        {adding ? (
          <ConditionEditor
            fields={fields}
            currency={currency}
            onCancel={() => setAdding(false)}
            onAdd={(c) => {
              update([...conditions, c]);
              setAdding(false);
            }}
          />
        ) : null}
      </section>

      {error ? <Alert tone="danger" title="Couldn’t filter">{error}</Alert> : null}
      {result?.statusNote ? <p className="text-xs text-muted">{result.statusNote}</p> : null}
      {result?.unattributed && result.unattributed.cents > 0 ? (
        <Alert tone="info" title="Some money isn’t linked to a service">
          {formatCents(result.unattributed.cents, currency)} received from {result.unattributed.customers} of these customers wasn’t applied to a specific service, so it isn’t counted in the service amounts above. Apply it from the receipt if it belongs to a service.
        </Alert>
      ) : null}

      <div className={cn("overflow-hidden rounded-xl border border-line bg-surface", loading && "opacity-70")} aria-busy={loading}>
        {result && result.rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">No customers match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <caption className="sr-only">Matching customers and their services</caption>
              <thead className="bg-canvas text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Customer</th>
                  {result?.columns.map((c) => <th key={c.key} scope="col" className="px-3 py-2 font-medium">{c.label}</th>)}
                  <th scope="col" className="px-3 py-2 text-right font-medium">Bookings</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Services</th>
                  {result?.moneyVisible ? <th scope="col" className="px-3 py-2 text-right font-medium">Paid (these services)</th> : null}
                </tr>
              </thead>
              {result?.rows.map((r) => (
                <tbody key={r.customerId} className="border-t border-line">
                  <tr className="bg-surface">
                    <th scope="row" className="px-3 py-2 text-left">
                      <Link href={`/dashboard/customers/${r.customerId}`} className="font-semibold text-brand underline-offset-4 hover:underline">{r.name}</Link>
                    </th>
                    {result.columns.map((c) => <td key={c.key} className="px-3 py-2">{cell(c.key, r.columns[c.key])}</td>)}
                    <td className="px-3 py-2 text-right tabular-nums">{r.bookings}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.services}</td>
                    {result.moneyVisible ? <td className="px-3 py-2 text-right font-semibold tabular-nums">{money(r.paidCents)}</td> : null}
                  </tr>
                  {r.lines.map((l) => (
                    <tr key={`${l.bookingId}-${l.service}-${l.date}`} className="text-xs text-muted">
                      <td className="py-1 pl-8 pr-3" colSpan={1 + result.columns.length}>
                        <Link href={`/dashboard/bookings/${l.bookingId}`} className="underline-offset-4 hover:underline">{fmtDate(l.date)}</Link> · <span className="text-ink">{l.service}{l.quantity > 1 ? ` ×${l.quantity}` : ""}</span> · {l.city}
                        {l.cleaners.length ? ` · ${l.cleaners.join(", ")}` : " · Unassigned"}
                        {l.status !== "COMPLETED" ? <Badge tone="slate" className="ml-2">{BOOKING_STATUS_LABELS[l.status]}</Badge> : null}
                      </td>
                      <td className="py-1 pr-3" colSpan={2} />
                      {result.moneyVisible ? <td className="py-1 pr-3 text-right tabular-nums">{money(l.paidCents)}</td> : null}
                    </tr>
                  ))}
                  {r.moreLines ? (
                    <tr className="text-xs text-muted"><td className="py-1 pl-8" colSpan={4 + result.columns.length}>…and {r.moreLines} more (open the customer for full history)</td></tr>
                  ) : null}
                </tbody>
              ))}
            </table>
          </div>
        )}
        {result ? (
          <nav aria-label="Pages" className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
            <p>Page {result.page} of {result.totalPages} · {result.totals.customers} customers</p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button size="sm" variant="secondary" disabled={page >= result.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </nav>
        ) : null}
      </div>
      <p className="text-xs text-muted">
        City filters use the address where each job was done. “Customer address city” uses the customer’s current addresses. Amounts are payments applied to each matching service — booking prices are never counted as paid, and other services on the same booking are excluded. Totals cover all matching results, not just this page.
      </p>

      <Modal title="Select columns" open={columnsOpen} onClose={() => setColumnsOpen(false)}>
        <fieldset className="space-y-2">
          <legend className="sr-only">Columns</legend>
          {result?.availableColumns.map((c) => (
            <label key={c.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-brand" checked={columns.includes(c.key)} onChange={(e) => setColumns((cur) => (e.target.checked ? [...cur, c.key] : cur.filter((x) => x !== c.key)))} />
              {c.label}
            </label>
          ))}
        </fieldset>
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={() => setColumnsOpen(false)}>Done</Button>
        </div>
      </Modal>
    </div>
  );
}
