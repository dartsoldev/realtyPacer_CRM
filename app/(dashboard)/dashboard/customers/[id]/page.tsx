import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarPlus, ClipboardList, Pencil } from "lucide-react";
import { RecordPaymentButton } from "@/components/finance/payment-dialogs";
import { LoyaltyEntryButton, ReverseLoyaltyButton } from "@/components/finance/loyalty-actions";
import { BillingStateBadge, PaymentStatusBadge } from "@/components/finance/status";
import { CustomFieldValues } from "@/components/custom-fields/values";
import { Types } from "mongoose";
import { ActivityFeed } from "@/components/ops/activity-feed";
import { AddressManager } from "@/components/ops/address-manager";
import { ArchiveCustomerButton } from "@/components/ops/archive-button";
import { EmailLink, MapLink, PhoneLink } from "@/components/ops/contact";
import { BookingStatusBadge } from "@/components/ops/status";
import { AccessDenied } from "@/components/shell/access";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/ui/button";
import { Card, CardHeader, EmptyState } from "@/components/ui/layout";
import { Pagination } from "@/components/ui/pagination";
import { cn } from "@/components/ui/cn";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { CONTACT_SOURCE_LABELS, CUSTOMER_TYPE_LABELS } from "@/lib/domain/constants";
import { relationshipDuration } from "@/lib/domain/duration";
import { formatAddress } from "@/lib/domain/links";
import { formatCents } from "@/lib/domain/money";
import { formatDate, formatDateTime } from "@/lib/domain/time";
import { todayKey } from "@/lib/domain/zoned-time";
import { AppError } from "@/lib/http/errors";
import { listAddresses } from "@/modules/customers/addresses";
import { customerHistory, customerMetrics, getCustomer } from "@/modules/customers/service";
import { customFieldDefsFor } from "@/modules/custom-fields/service";
import { openCharges } from "@/modules/finance/payments";
import { customerFinanceHistory, customerFinancialSummary } from "@/modules/finance/summary";
import { loyaltyHistory } from "@/modules/loyalty/service";
import { LOYALTY_ENTRY_LABELS, PAYMENT_METHOD_LABELS } from "@/lib/domain/constants";

export const metadata: Metadata = { title: "Customer" };

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "addresses", label: "Service addresses" },
  { key: "history", label: "Bookings & service history" },
  { key: "activity", label: "Notes & activity" },
  { key: "finance", label: "Finance" },
  { key: "loyalty", label: "Loyalty points" },
] as const;

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CustomerProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const user = await requirePageUser(`/dashboard/customers/${id}`);
  // Cleaners following a booking link land here: the full profile is office-only.
  if (!can(user, "customers:read")) return <AccessDenied />;
  const sp = await searchParams;
  const visibleTabs = TABS.filter((t) => (t.key === "finance" ? can(user, "financials:read") : t.key === "loyalty" ? can(user, "loyalty:read") : true));
  const tab = (visibleTabs.find((t) => t.key === sp.tab)?.key ?? "overview") as (typeof TABS)[number]["key"];
  const page = Math.max(1, Math.min(1000, Number(sp.page) || 1));

  let customer;
  try {
    customer = await getCustomer(user, id);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  const tz = user.organization.timezone;
  const canBookings = can(user, "bookings:read");
  const [addresses, metrics] = await Promise.all([
    listAddresses(user, customer.id),
    canBookings ? customerMetrics(new Types.ObjectId(user.organizationId), new Types.ObjectId(customer.id), tz) : null,
  ]);
  const primary = addresses.find((a) => a.isPrimary) ?? null;
  const history = tab === "history" || tab === "overview" ? (canBookings ? await customerHistory(user, customer.id, tab === "history" ? page : 1, tab === "history" ? 20 : 5) : null) : null;
  const canWrite = can(user, "customers:write");
  const currency = user.organization.currency;
  const [finance, loyalty, cfDefs] = await Promise.all([
    tab === "finance" ? Promise.all([customerFinancialSummary(user, customer.id), customerFinanceHistory(user, customer.id), openCharges(user, customer.id)]) : null,
    tab === "loyalty" ? loyaltyHistory(user, customer.id, page) : null,
    tab === "overview" ? customFieldDefsFor(user.organizationId, "customer") : null,
  ]);

  return (
    <>
      <div className="mb-6 space-y-4">
        <nav aria-label="Breadcrumb" className="text-sm text-muted">
          <Link href="/dashboard/customers" className="underline-offset-4 hover:underline">
            Customers
          </Link>{" "}
          / <span className="text-ink">{customer.name}</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
              <Badge tone="slate">{CUSTOMER_TYPE_LABELS[customer.customerType]}</Badge>
              {customer.archived ? <Badge tone="slate">Archived</Badge> : null}
            </div>
            {customer.companyName && customer.companyName !== customer.name ? <p className="text-sm text-muted">{customer.companyName}</p> : null}
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              <PhoneLink e164={customer.phone} display={customer.phoneDisplay} />
              <EmailLink email={customer.email} />
              {!customer.phone && !customer.email ? <span className="text-muted">No contact details</span> : null}
            </div>
            {customer.tags.length ? (
              <div className="flex flex-wrap gap-1" aria-label="Tags">
                {customer.tags.map((t) => (
                  <Badge key={t} tone="purple">{t}</Badge>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {can(user, "payments:record") ? <RecordPaymentButton customer={{ id: customer.id, name: customer.name }} currency={currency} timezone={tz} variant="secondary" /> : null}
            {can(user, "bookings:write") && !customer.archived ? (
              <LinkButton href={`/dashboard/bookings/new?customerId=${customer.id}`}>
                <CalendarPlus className="size-4" aria-hidden /> Create booking
              </LinkButton>
            ) : null}
            {canWrite ? (
              <LinkButton href={`/dashboard/customers/${customer.id}/edit`} variant="secondary">
                <Pencil className="size-4" aria-hidden /> Edit
              </LinkButton>
            ) : null}
            {canWrite ? <ArchiveCustomerButton customerId={customer.id} archived={customer.archived} /> : null}
          </div>
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Customer since</dt>
          <dd>
            {customer.relationshipStartedAt ? `${formatDate(`${customer.relationshipStartedAt}T12:00:00Z`, "UTC")} (${relationshipDuration(customer.relationshipStartedAt, todayKey(tz))})` : "Not specified"}
          </dd>
          <dt className="text-muted">Default address</dt>
          <dd className="flex flex-wrap items-center gap-x-3">
            {primary ? (
              <>
                <span>{formatAddress(primary)}</span>
                <MapLink href={primary.mapUrl} />
              </>
            ) : (
              <span className="text-muted">None yet</span>
            )}
          </dd>
          {customer.contactSource ? (
            <>
              <dt className="text-muted">Source</dt>
              <dd>{CONTACT_SOURCE_LABELS[customer.contactSource]}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <nav aria-label="Customer sections" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {visibleTabs.map((t) => (
          <Link
            key={t.key}
            href={`/dashboard/customers/${customer.id}${t.key === "overview" ? "" : `?tab=${t.key}`}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={cn(
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
              tab === t.key ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="space-y-6">
          {metrics ? (
            <section aria-labelledby="metrics-h">
              <h2 id="metrics-h" className="sr-only">Service metrics</h2>
              <dl className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
                {[
                  ["Completed bookings", String(metrics.completedBookings), "Bookings marked completed"],
                  ["Completed service items", String(metrics.completedServiceItems), "Sum of item quantities in completed bookings"],
                  ["Distinct service days", String(metrics.distinctServiceDays), `Different local dates (${tz}) with a completed booking`],
                  ["Upcoming bookings", String(metrics.upcomingBookings), "Scheduled from now on"],
                  ["First completed service", metrics.firstCompletedAt ? formatDate(metrics.firstCompletedAt, tz) : "—", "Scheduled date"],
                  ["Last completed service", metrics.lastCompletedAt ? formatDate(metrics.lastCompletedAt, tz) : "—", "Scheduled date"],
                ].map(([label, value, hint]) => (
                  <div key={label} className="rounded-xl border border-line bg-surface p-4">
                    <dt className="text-xs font-medium text-muted">{label}</dt>
                    <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
                    <dd className="mt-1 text-xs text-muted">{hint}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Recent bookings" actions={canBookings ? <Link href={`/dashboard/customers/${customer.id}?tab=history`} className="text-sm font-medium text-brand underline-offset-4 hover:underline">All bookings</Link> : null} />
              {history && history.items.length ? (
                <ul className="divide-y divide-line">
                  {history.items.map((h) => (
                    <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                      <Link href={`/dashboard/bookings/${h.id}`} className="font-medium underline-offset-4 hover:underline">
                        {formatDateTime(h.scheduledStartAt, tz)}
                      </Link>
                      <BookingStatusBadge status={h.status} />
                      <p className="w-full text-muted">{h.services}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-6 text-sm text-muted">{canBookings ? "No bookings yet." : "You don't have access to bookings."}</p>
              )}
            </Card>
            <Card>
              <CardHeader title="Internal notes" description="Office only" />
              <p className="whitespace-pre-wrap px-5 py-4 text-sm">{customer.notes || <span className="text-muted">No notes.</span>}</p>
            </Card>
          </div>
          {cfDefs && cfDefs.length ? (
            <Card>
              <CardHeader title="Additional details" description="Custom fields set by your organization" />
              <CustomFieldValues defs={cfDefs} values={customer.customFields} timezone={tz} />
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === "addresses" ? (
        <Card className="p-5">
          <AddressManager customerId={customer.id} addresses={addresses} canWrite={canWrite} />
        </Card>
      ) : null}

      {tab === "history" ? (
        <Card>
          {!history ? (
            <EmptyState icon={ClipboardList} title="You don't have access to bookings" />
          ) : history.items.length === 0 ? (
            <EmptyState icon={ClipboardList} title="No bookings yet" />
          ) : (
            <>
              <ul className="divide-y divide-line">
                {history.items.map((h) => (
                  <li key={h.id} className="grid gap-1 px-5 py-3 text-sm md:grid-cols-[11rem_1fr_auto] md:gap-4">
                    <div>
                      <Link href={`/dashboard/bookings/${h.id}`} className="font-medium underline-offset-4 hover:underline">
                        {formatDateTime(h.scheduledStartAt, tz)}
                      </Link>
                      <p className="text-xs text-muted">{h.reference}</p>
                    </div>
                    <div className="min-w-0">
                      <p>{h.services}</p>
                      <p className="text-muted">{h.address}</p>
                      <p className="text-muted">{h.cleaners.length ? `Cleaners: ${h.cleaners.join(", ")}` : "Unassigned"}</p>
                    </div>
                    <div className="flex items-start gap-3 md:flex-col md:items-end">
                      <BookingStatusBadge status={h.status} />
                      {h.subtotalCents !== null ? <span className="tabular-nums">{formatCents(h.subtotalCents, h.currency)}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
              <Pagination page={history.page} totalPages={history.totalPages} total={history.total} basePath={`/dashboard/customers/${customer.id}`} params={{ tab: "history" }} />
            </>
          )}
        </Card>
      ) : null}

      {tab === "activity" ? (
        <Card className="p-5">
          <ActivityFeed customerId={customer.id} canWrite={can(user, "activities:write")} timezone={tz} />
        </Card>
      ) : null}

      {tab === "finance" && finance ? <FinanceTab customerId={customer.id} data={finance} currency={currency} timezone={tz} /> : null}

      {tab === "loyalty" && loyalty ? (
        <Card>
          <CardHeader
            title={`Points balance: ${loyalty.balance}`}
            description="Every change is a ledger entry with a reason. Entries are reversed, never edited."
            actions={can(user, "loyalty:adjust") ? <LoyaltyEntryButton customerId={customer.id} balance={loyalty.balance} /> : null}
          />
          {loyalty.items.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">No points activity yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead className="bg-canvas text-left text-xs text-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">Date</th>
                    <th scope="col" className="px-4 py-2 font-medium">Entry</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Change</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Balance after</th>
                    <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {loyalty.items.map((e) => (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap px-4 py-2">{formatDateTime(e.occurredAt, tz)}</td>
                      <td className="px-4 py-2">
                        <span className="font-medium">{LOYALTY_ENTRY_LABELS[e.type]}</span>
                        {e.reversed ? <Badge tone="slate" className="ml-2">Reversed</Badge> : null}
                        <span className="block text-muted">{e.reason}{e.by ? ` · ${e.by}` : ""}</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">{e.pointsChange > 0 ? `+${e.pointsChange}` : e.pointsChange}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{e.balanceAfter}</td>
                      <td className="px-4 py-2 text-right">{can(user, "loyalty:adjust") && !e.reversed && e.type !== "reversal" ? <ReverseLoyaltyButton customerId={customer.id} entryId={e.id} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={loyalty.page} totalPages={loyalty.totalPages} total={loyalty.total} basePath={`/dashboard/customers/${customer.id}`} params={{ tab: "loyalty" }} />
        </Card>
      ) : null}
    </>
  );
}

type FinanceData = [Awaited<ReturnType<typeof customerFinancialSummary>>, Awaited<ReturnType<typeof customerFinanceHistory>>, Awaited<ReturnType<typeof openCharges>>];

function FinanceTab({ customerId, data: [summary, history, open], currency, timezone }: { customerId: string; data: FinanceData; currency: string; timezone: string }) {
  const money = (c: number) => formatCents(c, currency);
  const cards: [string, string, string][] = [
    ["Outstanding now", money(summary.outstandingCents), "Finalized charges after adjustments, minus what has been applied"],
    ["Unapplied credit", money(summary.unallocatedCreditCents), "Received but not yet applied to a charge"],
    ["Net received (lifetime)", money(summary.netReceivedCents), `${money(summary.grossReceiptsCents)} received − ${money(summary.refundsCents)} refunded`],
    ["Charges (lifetime)", money(summary.chargesAfterAdjustmentsCents), `${money(summary.finalizedChargesCents)} finalized ${summary.adjustmentsCents < 0 ? "−" : "+"} ${money(Math.abs(summary.adjustmentsCents))} adjustments`],
    ["Draft estimates", money(summary.draftEstimateCents), "Bookings not yet finalized. Not owed."],
    ["Last payment", summary.lastPaymentAt ? formatDate(summary.lastPaymentAt, timezone) : "—", "Most recent posted receipt"],
  ];
  return (
    <div className="space-y-6">
      <section aria-labelledby="fin-h">
        <h2 id="fin-h" className="sr-only">Financial summary</h2>
        <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map(([label, value, hint]) => (
            <div key={label} className="rounded-xl border border-line bg-surface p-4">
              <dt className="text-xs font-medium text-muted">{label}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
              <dd className="mt-1 text-xs text-muted">{hint}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted">Lifetime figures are computed from receipts, refunds, finalized charges and adjustments — not from booking prices.</p>
      </section>

      <Card>
        <CardHeader title="Still owed" description="Finalized charges with an unpaid balance, oldest first" />
        {open.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">Nothing is owed.</p>
        ) : (
          <ul className="divide-y divide-line">
            {open.map((b) => (
              <li key={b.bookingId} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <div>
                  <Link href={`/dashboard/bookings/${b.bookingId}`} className="font-medium underline-offset-4 hover:underline">{b.reference}</Link> · {formatDate(b.serviceDate, timezone)}
                  <p className="text-muted">{b.lines.filter((l) => l.balanceCents > 0).map((l) => `${l.name} ${money(l.balanceCents)}`).join(" · ")}</p>
                </div>
                <span className="font-semibold tabular-nums">{money(b.balanceCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Payments and refunds" description="Most recent 100" actions={<Link href={`/dashboard/payments?customerId=${customerId}`} className="text-sm font-medium text-brand underline-offset-4 hover:underline">Open in Payments</Link>} />
        {history.transactions.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">No payments recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="bg-canvas text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Date</th>
                  <th scope="col" className="px-4 py-2 font-medium">Entry</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Credit left</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.transactions.map((t) => (
                  <tr key={`${t.kind}-${t.id}`} className={t.status === "REVERSED" ? "text-muted" : undefined}>
                    <td className="whitespace-nowrap px-4 py-2">{formatDateTime(t.at, timezone)}</td>
                    <td className="px-4 py-2">
                      <Link href={`/dashboard/payments/${t.paymentId}`} className="font-medium underline-offset-4 hover:underline">
                        {t.kind === "refund" ? `Refund on ${t.receiptNumber}` : t.receiptNumber}
                      </Link>
                      {t.kind === "receipt" && t.status === "REVERSED" ? <span className="ml-2"><PaymentStatusBadge status="REVERSED" refundState="none" /></span> : null}
                      <span className="block text-muted">{[t.method ? PAYMENT_METHOD_LABELS[t.method] : "", t.reason].filter(Boolean).join(" · ")}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">{t.kind === "refund" ? `−${money(t.amountCents)}` : money(t.amountCents)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{t.unallocatedCents !== null && t.status === "POSTED" ? money(t.unallocatedCents) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Charges by booking" description="Most recent 100. Draft amounts are estimates and are not owed." />
        {history.charges.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted">No bookings.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead className="bg-canvas text-left text-xs text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Booking</th>
                  <th scope="col" className="px-4 py-2 font-medium">Services</th>
                  <th scope="col" className="px-4 py-2 font-medium">Billing</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Charged</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Paid</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {history.charges.map((c) => (
                  <tr key={c.bookingId}>
                    <td className="px-4 py-2">
                      <Link href={`/dashboard/bookings/${c.bookingId}`} className="font-medium underline-offset-4 hover:underline">{c.reference}</Link>
                      <span className="block text-xs text-muted">{formatDate(c.serviceDate, timezone)}{c.city ? ` · ${c.city}` : ""}</span>
                    </td>
                    <td className="px-4 py-2">{c.services}</td>
                    <td className="px-4 py-2"><BillingStateBadge state={c.billingState as "DRAFT" | "FINALIZED"} /></td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.chargedCents !== null ? money(c.chargedCents) : <span className="text-muted">est. {money(c.estimateCents ?? 0)}</span>}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{money(c.paidCents)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.balanceCents !== null ? money(c.balanceCents) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
