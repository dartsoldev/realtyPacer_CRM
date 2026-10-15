import type { Metadata } from "next";
import Link from "next/link";
import { CreditCard, X } from "lucide-react";
import { RecordPaymentButton } from "@/components/finance/payment-dialogs";
import { PaymentStatusBadge } from "@/components/finance/status";
import { AccessDenied } from "@/components/shell/access";
import { buttonClasses } from "@/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Pagination } from "@/components/ui/pagination";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@/lib/domain/constants";
import { formatCents } from "@/lib/domain/money";
import { formatDateTime } from "@/lib/domain/time";
import { listPayments, paymentListQuery } from "@/modules/finance/payments";

export const metadata: Metadata = { title: "Payments" };

const input = "h-10 w-full rounded-lg border border-line bg-surface px-3 text-base sm:text-sm";

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/payments");
  if (!can(user, "financials:read")) return <AccessDenied />;
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v)) as Record<string, string>;
  const parsed = paymentListQuery.safeParse(raw);
  const q = parsed.success ? parsed.data : paymentListQuery.parse({});
  const result = await listPayments(user, q);
  const { currency, timezone } = user.organization;
  const keep: Record<string, string | undefined> = { q: q.q, method: q.method, status: q.status, from: q.from, to: q.to, unallocated: q.unallocated, refunded: q.refunded, customerId: q.customerId, sort: q.sort !== "receivedAt" ? q.sort : undefined, dir: q.dir !== "desc" ? q.dir : undefined };
  const chips = [
    q.q ? ["q", `Search: ${q.q}`] : null,
    q.method ? ["method", `Method: ${PAYMENT_METHOD_LABELS[q.method]}`] : null,
    q.status ? ["status", q.status === "REVERSED" ? "Reversed only" : "Posted only"] : null,
    q.from || q.to ? ["from", `Received: ${q.from ?? "…"} → ${q.to ?? "…"}`] : null,
    q.unallocated ? ["unallocated", "Has unapplied credit"] : null,
    q.refunded ? ["refunded", "Has refunds"] : null,
    q.customerId ? ["customerId", "One customer"] : null,
  ].filter(Boolean) as [string, string][];
  const without = (key: string) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(keep)) if (v && k !== key && !(key === "from" && k === "to")) sp.set(k, v);
    return `/dashboard/payments${sp.size ? `?${sp}` : ""}`;
  };
  const sortHref = (field: "receivedAt" | "amountCents") => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(keep)) if (v && k !== "sort" && k !== "dir") sp.set(k, v);
    const dir = q.sort === field && q.dir === "desc" ? "asc" : "desc";
    if (field !== "receivedAt") sp.set("sort", field);
    if (dir !== "desc") sp.set("dir", dir);
    return `/dashboard/payments${sp.size ? `?${sp}` : ""}`;
  };
  const ariaSort = (field: string) => (q.sort === field ? (q.dir === "asc" ? "ascending" : "descending") : undefined);
  const t = result.totals;

  return (
    <>
      <PageHeader
        title="Payments"
        description={`Money received outside RealtyPacer (cash, e-Transfer, cheque, external card terminal) and how it is applied. Times in ${timezone}.`}
        actions={can(user, "payments:record") ? <RecordPaymentButton currency={currency} timezone={timezone} /> : null}
      />
      <section aria-labelledby="pay-totals" className="mb-4">
        <h2 id="pay-totals" className="sr-only">Totals for these filters</h2>
        <dl className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          {[
            ["Receipts", t.receiptsCents],
            ["Refunds", t.refundsCents],
            ["Net received", t.netReceivedCents],
            ["Applied to charges", t.appliedCents],
            ["Unapplied credit", t.unallocatedCents],
          ].map(([label, v]) => (
            <div key={label as string} className="rounded-xl border border-line bg-surface p-4">
              <dt className="text-xs font-medium text-muted">{label}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums sm:text-xl">{formatCents(v as number, currency)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted">All matching receipts, not just this page. Basis: {t.basis}.</p>
      </section>
      <Card>
        <form method="get" role="search" aria-label="Filter payments" className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Search</span>
            <input name="q" defaultValue={q.q ?? ""} maxLength={100} placeholder="Receipt no., customer, reference" className={input} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Received from</span>
            <input type="date" name="from" defaultValue={q.from ?? ""} className={input} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Received to</span>
            <input type="date" name="to" defaultValue={q.to ?? ""} className={input} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Method</span>
            <select name="method" defaultValue={q.method ?? ""} className={input}>
              <option value="">Any method</option>
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Status</span>
            <select name="status" defaultValue={q.status ?? ""} className={input}>
              <option value="">Any status</option>
              <option value="POSTED">Posted</option>
              <option value="REVERSED">Reversed</option>
            </select>
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="unallocated" value="1" defaultChecked={Boolean(q.unallocated)} className="size-4 accent-brand" /> Has unapplied credit
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="refunded" value="1" defaultChecked={Boolean(q.refunded)} className="size-4 accent-brand" /> Has refunds
          </label>
          <div className="flex items-end gap-2">
            {q.customerId ? <input type="hidden" name="customerId" value={q.customerId} /> : null}
            <button type="submit" className={buttonClasses("secondary", "sm", "h-10")}>Apply</button>
          </div>
        </form>
        {chips.length ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm" aria-label="Active filters">
            <span className="text-muted">Filters:</span>
            {chips.map(([key, text]) => (
              <Link key={key} href={without(key)} className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand hover:underline" aria-label={`Remove filter ${text}`}>
                {text} <X className="size-3" aria-hidden />
              </Link>
            ))}
            <Link href="/dashboard/payments" className="text-xs font-medium text-muted underline">Clear all</Link>
          </div>
        ) : null}
        {result.items.length === 0 ? (
          <EmptyState icon={CreditCard} title={chips.length ? "No payments match these filters" : "No payments recorded yet"}>
            {chips.length ? "Try different filters." : "Record a payment when money is received. Booking prices alone are never treated as paid."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <caption className="sr-only">Payments</caption>
              <thead className="bg-canvas text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Receipt</th>
                  <th scope="col" className="px-4 py-2 font-medium" aria-sort={ariaSort("receivedAt")}>
                    <Link href={sortHref("receivedAt")} className="underline-offset-4 hover:underline">Received {q.sort === "receivedAt" ? (q.dir === "asc" ? "↑" : "↓") : ""}</Link>
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">Customer</th>
                  <th scope="col" className="px-4 py-2 font-medium">Method</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium" aria-sort={ariaSort("amountCents")}>
                    <Link href={sortHref("amountCents")} className="underline-offset-4 hover:underline">Amount {q.sort === "amountCents" ? (q.dir === "asc" ? "↑" : "↓") : ""}</Link>
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Applied</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Credit</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Refunded</th>
                  <th scope="col" className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.items.map((p) => (
                  <tr key={p.id} className={p.status === "REVERSED" ? "text-muted" : undefined}>
                    <td className="px-4 py-2">
                      <Link href={`/dashboard/payments/${p.id}`} className="whitespace-nowrap font-medium text-brand underline-offset-4 hover:underline">{p.receiptNumber}</Link>
                      {p.reference ? <span className="block text-xs text-muted">{p.reference}</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2">{formatDateTime(p.receivedAt, timezone)}</td>
                    <td className="px-4 py-2">
                      <Link href={`/dashboard/customers/${p.customer.id}?tab=finance`} className="underline-offset-4 hover:underline">{p.customer.name}</Link>
                    </td>
                    <td className="px-4 py-2">{PAYMENT_METHOD_LABELS[p.method]}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCents(p.amountCents, p.currency)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCents(p.appliedCents, p.currency)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCents(p.unallocatedCents, p.currency)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{p.refundedCents ? formatCents(p.refundedCents, p.currency) : "—"}</td>
                    <td className="px-4 py-2"><PaymentStatusBadge status={p.status} refundState={p.refundState} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={result.page} totalPages={result.totalPages} total={result.total} basePath="/dashboard/payments" params={keep} />
      </Card>
    </>
  );
}
