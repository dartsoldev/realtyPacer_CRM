import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, Pencil } from "lucide-react";
import { ActivityFeed } from "@/components/ops/activity-feed";
import { BookingActions, ChangeAddressButton } from "@/components/ops/booking-actions";
import { EmailLink, MapLink, PhoneLink } from "@/components/ops/contact";
import { AttachmentsPanel } from "@/components/ops/attachments-panel";
import { storageConfigured } from "@/lib/storage";
import { EmailCustomerButton } from "@/components/ops/booking-email";
import { CallActions } from "@/components/calls/call-actions";
import { browserCallingAvailable } from "@/modules/calls/service";
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
import { customFieldDefsFor } from "@/modules/custom-fields/service";
import { listAdjustments } from "@/modules/finance/charges";
import { AdjustLineButton, CancellationCreditButton, DiscountButton, FinalizeButton } from "@/components/finance/billing-actions";
import { RecordPaymentButton } from "@/components/finance/payment-dialogs";
import { BillingStateBadge } from "@/components/finance/status";
import { CustomFieldValues } from "@/components/custom-fields/values";
import { formatBasisPoints } from "@/lib/domain/billing";

export const metadata: Metadata = { title: "Booking" };

export default async function BookingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const sp = await searchParams;
  // Opened from the calendar: offer a way back to the same date and view.
  const calendarBack =
    sp.from === "calendar"
      ? `/dashboard/calendar?${new URLSearchParams({
          ...(typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? { date: sp.date } : {}),
          ...(typeof sp.view === "string" && ["dayGridMonth", "timeGridWeek", "timeGridDay", "listWeek"].includes(sp.view) ? { view: sp.view } : {}),
        })}`
      : null;
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
  const [adjustments, cfDefs] = await Promise.all([
    b.billing && b.billing.state === "FINALIZED" && can(user, "financials:read") ? listAdjustments(user, b.id) : [],
    Object.keys(b.customFields).length ? customFieldDefsFor(user.organizationId, "booking") : [],
  ]);
  const isFutureScheduled = b.status === "SCHEDULED" && new Date(b.scheduledStartAt) > new Date();

  return (
    <>
      {calendarBack ? (
        <p className="mb-2">
          <Link href={calendarBack} className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-brand underline-offset-4 hover:underline">
            ← Back to calendar
          </Link>
        </p>
      ) : null}
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
          {office && can(user, "bookings:notify") ? <EmailCustomerButton bookingId={b.id} cancelled={b.status === "CANCELLED"} timezone={tz} /> : null}
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
                <CallActions e164={b.customer.phone} display={b.customer.phoneDisplay} target={{ type: "customer", id: b.customer.id, name: b.customer.name, bookingId: b.id }} canLog={office && can(user, "calls:log")} browserCalling={office && browserCallingAvailable(user)} />
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

          {b.billing ? (
            <Card>
              <CardHeader
                title="Billing"
                description={b.billing.state === "FINALIZED" ? `Finalized${b.billing.finalizedAt ? ` ${formatDateTime(b.billing.finalizedAt, tz)}` : ""} — amounts are locked; use adjustments for corrections.` : "Draft estimate — nothing is owed until charges are finalized."}
                actions={<BillingStateBadge state={b.billing.state} />}
              />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm">
                  <thead className="bg-canvas text-left text-xs text-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">Service</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Price</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Discount</th>
                      {b.billing.tax.enabled ? <th scope="col" className="px-4 py-2 text-right font-medium">{b.billing.tax.label || "Tax"}</th> : null}
                      <th scope="col" className="px-4 py-2 text-right font-medium">{b.billing.state === "FINALIZED" ? "Charged" : "Estimate"}</th>
                      {b.billing.paidCents !== null ? <th scope="col" className="px-4 py-2 text-right font-medium">Paid</th> : null}
                      {b.billing.balanceCents !== null ? <th scope="col" className="px-4 py-2 text-right font-medium">Balance</th> : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {b.billing.lines.map((l) => (
                      <tr key={l.lineItemId}>
                        <td className="px-4 py-2">{l.name}{l.adjustmentCents ? <span className="block text-xs text-muted">Adjusted {l.adjustmentCents > 0 ? "+" : "−"}{formatCents(Math.abs(l.adjustmentCents), b.currency)}</span> : null}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{formatCents(l.grossCents, b.currency)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{l.discountCents ? `−${formatCents(l.discountCents, b.currency)}` : "—"}</td>
                        {b.billing!.tax.enabled ? <td className="px-4 py-2 text-right tabular-nums">{formatCents(l.taxCents, b.currency)}</td> : null}
                        <td className="px-4 py-2 text-right tabular-nums">{formatCents(l.chargedCents + l.adjustmentCents, b.currency)}</td>
                        {l.paidCents !== null ? <td className="px-4 py-2 text-right tabular-nums">{formatCents(l.paidCents, b.currency)}</td> : null}
                        {l.balanceCents !== null ? <td className="px-4 py-2 text-right tabular-nums">{formatCents(l.balanceCents, b.currency)}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line px-5 py-3 text-sm">
                <dt className="text-muted">Services</dt>
                <dd className="text-right tabular-nums">{formatCents(b.billing.grossCents, b.currency)}</dd>
                {b.billing.discountCents ? (
                  <>
                    <dt className="text-muted">Discount{b.billing.discount.type === "percent" ? ` (${formatBasisPoints(b.billing.discount.basisPoints)})` : ""}</dt>
                    <dd className="text-right tabular-nums">−{formatCents(b.billing.discountCents, b.currency)}</dd>
                  </>
                ) : null}
                <dt className="text-muted">{b.billing.tax.enabled ? `${b.billing.tax.label || "Tax"} (${formatBasisPoints(b.billing.tax.rateBasisPoints)})` : "Tax"}</dt>
                <dd className="text-right tabular-nums">{b.billing.tax.enabled ? formatCents(b.billing.taxCents, b.currency) : "Not configured"}</dd>
                {b.billing.adjustmentsCents ? (
                  <>
                    <dt className="text-muted">Adjustments</dt>
                    <dd className="text-right tabular-nums">{b.billing.adjustmentsCents > 0 ? "+" : "−"}{formatCents(Math.abs(b.billing.adjustmentsCents), b.currency)}</dd>
                  </>
                ) : null}
                <dt className="font-semibold">{b.billing.state === "FINALIZED" ? "Total charged" : "Estimated total"}</dt>
                <dd className="text-right font-semibold tabular-nums">{formatCents(b.billing.chargedCents + b.billing.adjustmentsCents, b.currency)}</dd>
                {b.billing.paidCents !== null ? (
                  <>
                    <dt className="text-muted">Paid (applied)</dt>
                    <dd className="text-right tabular-nums">{formatCents(b.billing.paidCents, b.currency)}</dd>
                  </>
                ) : null}
                {b.billing.balanceCents !== null ? (
                  <>
                    <dt className="font-semibold">Balance owed</dt>
                    <dd className="text-right font-semibold tabular-nums">{formatCents(b.billing.balanceCents, b.currency)}</dd>
                  </>
                ) : null}
              </dl>
              {adjustments.length ? (
                <div className="border-t border-line px-5 py-3 text-sm">
                  <h3 className="mb-1 font-medium">Adjustment history</h3>
                  <ul className="space-y-1">
                    {adjustments.map((x) => (
                      <li key={x.id} className="flex flex-wrap justify-between gap-2">
                        <span>{formatDateTime(x.createdAt, tz)} · {b.billing!.lines.find((l) => l.lineItemId === x.lineItemId)?.name ?? "Service"} · {x.reason}</span>
                        <span className="tabular-nums">{x.amountCents > 0 ? "+" : "−"}{formatCents(Math.abs(x.amountCents), b.currency)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2 border-t border-line px-5 py-3">
                {b.billing.state === "DRAFT" && can(user, "billing:finalize") && b.status !== "CANCELLED" ? (
                  <>
                    <DiscountButton bookingId={b.id} version={b.version} current={b.billing.discount} currency={b.currency} />
                    <FinalizeButton bookingId={b.id} version={b.version} chargedCents={b.billing.chargedCents} currency={b.currency} taxNote={b.billing.tax.enabled ? `${b.billing.tax.label || "Tax"} at ${formatBasisPoints(b.billing.tax.rateBasisPoints)} is included and locked in.` : "No tax is added (tax is not configured)."} />
                  </>
                ) : null}
                {b.billing.state === "FINALIZED" && can(user, "billing:adjust") && b.status !== "CANCELLED" ? (
                  <AdjustLineButton bookingId={b.id} currency={b.currency} lines={b.billing.lines.map((l) => ({ lineItemId: l.lineItemId, name: l.name, effectiveCents: l.chargedCents + l.adjustmentCents, paidCents: l.paidCents ?? 0 }))} />
                ) : null}
                {b.billing.state === "FINALIZED" && b.status === "CANCELLED" && can(user, "billing:adjust") && (b.billing.balanceCents ?? 0) > 0 ? (
                  <CancellationCreditButton bookingId={b.id} unpaidCents={b.billing.balanceCents ?? 0} currency={b.currency} />
                ) : null}
                {b.billing.state === "FINALIZED" && (b.billing.balanceCents ?? 0) > 0 && can(user, "payments:record") ? (
                  <RecordPaymentButton customer={{ id: b.customer.id, name: b.customer.name }} bookingId={b.id} currency={b.currency} timezone={tz} variant="secondary" />
                ) : null}
              </div>
            </Card>
          ) : null}

          {cfDefs.length && Object.keys(b.customFields).length ? (
            <Card>
              <CardHeader title="Additional details" />
              <CustomFieldValues defs={cfDefs} values={b.customFields} timezone={tz} />
            </Card>
          ) : null}

          {office ? can(user, "attachments:read") : can(user, "attachments:assigned") ? (
            <Card>
              <CardHeader title="Photos and documents" description={office ? "Before/after photos and job documents. Photos are visible to assigned cleaners; documents are office-only." : "Before/after photos for this job."} />
              <div className="p-5">
                <AttachmentsPanel
                  parentType="booking"
                  parentId={b.id}
                  categories={office ? ["before_photo", "after_photo", "document"] : ["before_photo", "after_photo"]}
                  canUpload={office ? can(user, "attachments:write") : b.status !== "CANCELLED"}
                  configured={storageConfigured()}
                  includeProperty
                />
              </div>
            </Card>
          ) : null}

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
                    {office && can(user, "cleaners:read") ? (
                      <CallActions e164={c.phone} display={c.phoneDisplay} target={{ type: "cleaner", id: c.id, name: c.name, bookingId: b.id }} canLog={can(user, "calls:log")} browserCalling={browserCallingAvailable(user)} compact />
                    ) : (
                      <PhoneLink e164={c.phone} display={c.phoneDisplay} />
                    )}
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
