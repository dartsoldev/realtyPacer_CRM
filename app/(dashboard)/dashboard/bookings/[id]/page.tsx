import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, Pencil } from "lucide-react";
import { ActivityFeed } from "@/components/ops/activity-feed";
import { BookingActions, ChangeAddressButton } from "@/components/ops/booking-actions";
import { EmailLink, MapLink, PhoneLink } from "@/components/ops/contact";
import { BookingStatusBadge, UnassignedBadge } from "@/components/ops/status";
import { AccessDenied } from "@/components/shell/access";
import { LinkButton } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { formatMinutes } from "@/lib/domain/duration";
import { formatAddress } from "@/lib/domain/links";
import { formatCents } from "@/lib/domain/money";
import { formatDate, formatDateTime } from "@/lib/domain/time";
import { AppError } from "@/lib/http/errors";
import { getBooking } from "@/modules/bookings/service";

export const metadata: Metadata = { title: "Booking" };

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser(`/dashboard/bookings/${id}`);
  let b;
  try {
    b = await getBooking(user, id);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    if (err instanceof AppError && err.status === 403) return <AccessDenied />;
    throw err;
  }
  const office = can(user, "bookings:read");
  const tz = b.timezone;
  const isFutureScheduled = b.status === "SCHEDULED" && new Date(b.scheduledStartAt) > new Date();

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted">
        {office ? (
          <Link href="/dashboard/bookings" className="underline-offset-4 hover:underline">Bookings</Link>
        ) : (
          <Link href="/dashboard" className="underline-offset-4 hover:underline">My jobs</Link>
        )}{" "}
        / <span className="text-ink">{b.reference}</span>
      </nav>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{b.reference}</h1>
            <BookingStatusBadge status={b.status} />
            {b.cleaners.length === 0 && (b.status === "SCHEDULED" || b.status === "IN_PROGRESS") ? <UnassignedBadge /> : null}
          </div>
          <p className="text-lg">
            {formatDate(b.scheduledStartAt, tz)}, <span className="tabular-nums">{b.local.startTime}–{b.local.endTime}</span>
            {b.local.endDate !== b.local.date ? ` (ends ${formatDate(b.scheduledEndAt, tz)})` : ""}
          </p>
          <p className="text-sm text-muted">
            {formatMinutes(b.durationMinutes)} · times in {tz}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {office && b.editable.length ? (
            <LinkButton href={`/dashboard/bookings/${b.id}/edit`} variant="secondary">
              <Pencil className="size-4" aria-hidden /> Edit
            </LinkButton>
          ) : null}
          {office && can(user, "calendar:read") ? (
            <LinkButton href={`/dashboard/calendar?date=${b.local.date}`} variant="ghost">
              <CalendarDays className="size-4" aria-hidden /> In calendar
            </LinkButton>
          ) : null}
        </div>
      </div>

      <div className="mb-6">
        <BookingActions bookingId={b.id} version={b.version} actions={b.allowedActions} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Customer" />
            <div className="space-y-2 px-5 py-4 text-sm">
              {b.customer.profileAccessible ? (
                <Link href={`/dashboard/customers/${b.customer.id}`} className="text-base font-semibold underline-offset-4 hover:underline">
                  {b.customer.name}
                </Link>
              ) : (
                <p className="text-base font-semibold">{b.customer.name}</p>
              )}
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                <PhoneLink e164={b.customer.phone} display={b.customer.phoneDisplay} />
                <EmailLink email={b.customer.email} />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Service address" description="As saved on this booking" actions={office && b.editable.includes("address") && isFutureScheduled ? <ChangeAddressButton bookingId={b.id} customerId={b.customer.id} version={b.version} currentAddressId={b.address.addressId} /> : null} />
            <div className="space-y-2 px-5 py-4 text-sm">
              {b.address.label ? <p className="font-medium">{b.address.label}</p> : null}
              <p>{formatAddress(b.address)}</p>
              <MapLink href={b.address.mapUrl} />
              {b.address.accessInstructions ? (
                <p className="rounded-md bg-canvas p-2">
                  <span className="font-medium">Access / parking: </span>
                  {b.address.accessInstructions}
                </p>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Services" />
            <ul className="divide-y divide-line">
              {b.lineItems.map((l) => (
                <li key={l.id} className="flex flex-wrap justify-between gap-2 px-5 py-3 text-sm">
                  <div>
                    <p className="font-medium">{l.name}</p>
                    <p className="text-muted">
                      {l.quantity} {l.unitLabel}
                      {l.quantity === 1 ? "" : "s"} · {formatMinutes(l.durationMinutes * l.quantity)} estimated
                      {l.unitPriceCents !== null ? ` · ${formatCents(l.unitPriceCents, b.currency)} each` : ""}
                      {l.unitPriceCents !== null && l.catalogUnitPriceCents !== null && l.unitPriceCents !== l.catalogUnitPriceCents ? " (custom price)" : ""}
                    </p>
                  </div>
                  {l.lineTotalCents !== null ? <p className="font-medium tabular-nums">{formatCents(l.lineTotalCents, b.currency)}</p> : null}
                </li>
              ))}
            </ul>
            {b.subtotalCents !== null ? (
              <p className="flex justify-between border-t border-line px-5 py-3 text-sm">
                <span>
                  <span className="font-semibold">Service subtotal</span> <span className="text-muted">(no taxes or discounts; not a payment)</span>
                </span>
                <span className="font-semibold tabular-nums">{formatCents(b.subtotalCents, b.currency)}</span>
              </p>
            ) : null}
          </Card>

          <Card>
            <CardHeader title="Job instructions" description="Visible to the assigned cleaners" />
            <p className="whitespace-pre-wrap px-5 py-4 text-sm">{b.instructions || <span className="text-muted">None.</span>}</p>
          </Card>

          {office ? (
            <Card>
              <CardHeader title="History" />
              <div className="p-5">
                <ActivityFeed bookingId={b.id} canWrite={can(user, "activities:write")} timezone={tz} />
              </div>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Assigned cleaners" />
            {b.cleaners.length ? (
              <ul className="divide-y divide-line">
                {b.cleaners.map((c) => (
                  <li key={c.id} className="space-y-1 px-5 py-3 text-sm">
                    {office && can(user, "cleaners:read") ? (
                      <Link href={`/dashboard/cleaners/${c.id}`} className="font-medium underline-offset-4 hover:underline">{c.name}</Link>
                    ) : (
                      <p className="font-medium">{c.name}</p>
                    )}
                    {!c.active ? <p className="text-xs text-danger">Inactive — reassign this job</p> : null}
                    <PhoneLink e164={c.phone} display={c.phoneDisplay} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">Nobody is assigned yet.</p>
            )}
          </Card>

          <Card>
            <CardHeader title="Timeline" />
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-5 py-4 text-sm">
              <dt className="text-muted">Scheduled</dt>
              <dd>{formatDateTime(b.scheduledStartAt, tz)}</dd>
              <dt className="text-muted">Started</dt>
              <dd>{b.actualStartedAt ? formatDateTime(b.actualStartedAt, tz) : "—"}</dd>
              <dt className="text-muted">Completed</dt>
              <dd>{b.completedAt ? formatDateTime(b.completedAt, tz) : "—"}</dd>
              {b.cancelledAt ? (
                <>
                  <dt className="text-muted">Cancelled</dt>
                  <dd>{formatDateTime(b.cancelledAt, tz)}</dd>
                  {b.cancellationReason ? (
                    <>
                      <dt className="text-muted">Reason</dt>
                      <dd>{b.cancellationReason}</dd>
                    </>
                  ) : null}
                </>
              ) : null}
            </dl>
          </Card>

          {b.officeNotes !== null ? (
            <Card>
              <CardHeader title="Office notes" description="Internal — not visible to cleaners" />
              <p className="whitespace-pre-wrap px-5 py-4 text-sm">{b.officeNotes || <span className="text-muted">None.</span>}</p>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
