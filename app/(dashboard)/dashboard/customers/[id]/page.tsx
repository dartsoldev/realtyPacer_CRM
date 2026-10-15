import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarPlus, ClipboardList, CreditCard, Pencil } from "lucide-react";
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

export const metadata: Metadata = { title: "Customer" };

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "addresses", label: "Service addresses" },
  { key: "history", label: "Bookings & service history" },
  { key: "activity", label: "Notes & activity" },
  { key: "payments", label: "Payments" },
] as const;

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CustomerProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const { id } = await params;
  const user = await requirePageUser(`/dashboard/customers/${id}`);
  // Cleaners following a booking link land here: the full profile is office-only.
  if (!can(user, "customers:read")) return <AccessDenied />;
  const sp = await searchParams;
  const tab = (TABS.find((t) => t.key === sp.tab)?.key ?? "overview") as (typeof TABS)[number]["key"];
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
        {TABS.map((t) => (
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

      {tab === "payments" ? (
        <Card>
          <EmptyState icon={CreditCard} title="Payments aren’t recorded yet" badge={<Badge tone="info">Coming in phase 3</Badge>}>
            Total paid and outstanding balance will appear once payments are recorded and allocated to booking services. Booking prices are not treated as money received.
          </EmptyState>
        </Card>
      ) : null}
    </>
  );
}
