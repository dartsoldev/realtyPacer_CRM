import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApplyCreditButton, RefundButton, ReversePaymentButton } from "@/components/finance/payment-dialogs";
import { PrintButton } from "@/components/finance/print-button";
import { PaymentStatusBadge } from "@/components/finance/status";
import { AccessDenied } from "@/components/shell/access";
import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { PAYMENT_METHOD_LABELS } from "@/lib/domain/constants";
import { formatCents } from "@/lib/domain/money";
import { formatDate, formatDateTime } from "@/lib/domain/time";
import { AppError } from "@/lib/http/errors";
import { getPayment } from "@/modules/finance/payments";

export const metadata: Metadata = { title: "Payment" };

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser(`/dashboard/payments/${id}`);
  if (!can(user, "financials:read")) return <AccessDenied />;
  let p;
  try {
    p = await getPayment(user, id);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  const tz = user.organization.timezone;
  const posted = p.status === "POSTED";
  const refundable = [
    ...(p.unallocatedCents > 0 ? [{ allocationId: null, label: "Unapplied credit", availableCents: p.unallocatedCents }] : []),
    ...p.allocations.filter((a) => a.amountCents - a.refundedCents > 0).map((a) => ({ allocationId: a.id, label: `${a.bookingReference} · ${a.lineName}`, availableCents: a.amountCents - a.refundedCents })),
  ];

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted print:hidden">
        <Link href="/dashboard/payments" className="underline-offset-4 hover:underline">Payments</Link> / <span className="text-ink">{p.receiptNumber}</span>
      </nav>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Receipt {p.receiptNumber}</h1>
            <PaymentStatusBadge status={p.status} refundState={p.refundState} />
          </div>
          <p className="text-sm text-muted">
            {user.organization.displayName} · Payment acknowledgment (not a tax invoice)
          </p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          {posted && p.unallocatedCents > 0 && can(user, "payments:allocate") ? (
            <ApplyCreditButton paymentId={p.id} customerId={p.customer.id} revision={p.revision} availableCents={p.unallocatedCents} currency={p.currency} timezone={tz} />
          ) : null}
          {posted && refundable.length && can(user, "payments:refund") ? <RefundButton paymentId={p.id} parts={refundable} currency={p.currency} timezone={tz} /> : null}
          {posted && p.refundedCents === 0 && can(user, "payments:refund") ? <ReversePaymentButton paymentId={p.id} revision={p.revision} /> : null}
          <PrintButton />
        </div>
      </div>

      {p.reversal ? (
        <Alert tone="pending" title="This receipt was reversed" className="mb-4">
          {p.reversal.at ? formatDateTime(p.reversal.at, tz) : ""} {p.reversal.by ? `by ${p.reversal.by}` : ""} — {p.reversal.reason}. It no longer counts as money received.
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[2fr_3fr]">
        <Card>
          <CardHeader title="Receipt" />
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 px-5 py-4 text-sm">
            <dt className="text-muted">Customer</dt>
            <dd>
              <Link href={`/dashboard/customers/${p.customer.id}?tab=finance`} className="font-medium underline-offset-4 hover:underline">{p.customer.name}</Link>
              {p.customerContact.phoneDisplay || p.customerContact.email ? <span className="block text-muted">{[p.customerContact.phoneDisplay, p.customerContact.email].filter(Boolean).join(" · ")}</span> : null}
            </dd>
            <dt className="text-muted">Amount received</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatCents(p.amountCents, p.currency)}</dd>
            <dt className="text-muted">Received</dt>
            <dd>{formatDateTime(p.receivedAt, tz)}</dd>
            <dt className="text-muted">Method</dt>
            <dd>{PAYMENT_METHOD_LABELS[p.method]}</dd>
            {p.reference ? (
              <>
                <dt className="text-muted">Reference</dt>
                <dd className="break-all">{p.reference}</dd>
              </>
            ) : null}
            <dt className="text-muted">Applied to charges</dt>
            <dd className="tabular-nums">{formatCents(p.appliedCents, p.currency)}</dd>
            <dt className="text-muted">Unapplied credit</dt>
            <dd className="tabular-nums">{formatCents(p.unallocatedCents, p.currency)}</dd>
            <dt className="text-muted">Refunded</dt>
            <dd className="tabular-nums">{formatCents(p.refundedCents, p.currency)}</dd>
            {p.note ? (
              <>
                <dt className="text-muted print:hidden">Internal note</dt>
                <dd className="whitespace-pre-wrap print:hidden">{p.note}</dd>
              </>
            ) : null}
            <dt className="text-muted print:hidden">Recorded</dt>
            <dd className="print:hidden">{formatDateTime(p.recordedAt, tz)}{p.recordedBy ? ` by ${p.recordedBy}` : ""}</dd>
          </dl>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Applied to" description="Each allocation pays a specific booked service." />
            {p.allocations.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted">Not applied to any charge. The full amount is customer credit.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[34rem] text-sm">
                  <thead className="bg-canvas text-left text-xs text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">Booking</th>
                      <th scope="col" className="px-4 py-2 font-medium">Service</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Applied</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Refunded</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {p.allocations.map((a) => (
                      <tr key={a.id}>
                        <td className="px-4 py-2">
                          <Link href={`/dashboard/bookings/${a.bookingId}`} className="font-medium underline-offset-4 hover:underline">{a.bookingReference}</Link>
                          <span className="block text-xs text-muted">{a.serviceDate ? formatDate(a.serviceDate, tz) : ""}{a.city ? ` · ${a.city}` : ""}</span>
                        </td>
                        <td className="px-4 py-2">
                          {a.lineName}
                          {a.source === "credit" ? <span className="block text-xs text-muted">Applied later from credit · {formatDate(a.allocatedAt, tz)}</span> : null}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatCents(a.amountCents, p.currency)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{a.refundedCents ? formatCents(a.refundedCents, p.currency) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="Refunds" description="Recorded after the money was returned outside RealtyPacer." />
            {p.refunds.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted">No refunds.</p>
            ) : (
              <ul className="divide-y divide-line">
                {p.refunds.map((r) => (
                  <li key={r.id} className="flex flex-wrap justify-between gap-2 px-5 py-3 text-sm">
                    <div>
                      <p className="font-medium">{formatDateTime(r.refundedAt, tz)}</p>
                      <p className="text-muted">{r.reason}{r.reference ? ` · Ref ${r.reference}` : ""}{r.by ? ` · ${r.by}` : ""}</p>
                    </div>
                    <span className="font-semibold tabular-nums">−{formatCents(r.amountCents, p.currency)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
