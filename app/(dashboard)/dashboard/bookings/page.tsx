import type { Metadata } from "next";
import Link from "next/link";
import { CalendarPlus, ClipboardList, X } from "lucide-react";
import { BookingList } from "@/components/ops/booking-list";
import { AccessDenied } from "@/components/shell/access";
import { plural } from "@/components/shell/nav-config";
import { buttonClasses, LinkButton } from "@/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Pagination } from "@/components/ui/pagination";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { BOOKING_STATUS_LABELS, BOOKING_STATUSES } from "@/lib/domain/constants";
import { bookingListQuery } from "@/modules/bookings/schemas";
import { listBookings } from "@/modules/bookings/service";
import { assignableCleaners, listCleaners } from "@/modules/cleaners/service";

export const metadata: Metadata = { title: "Bookings" };

export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/bookings");
  if (!can(user, "bookings:read")) return <AccessDenied />;
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v)) as Record<string, string>;
  const parsed = bookingListQuery.safeParse(raw);
  const q = parsed.success ? parsed.data : bookingListQuery.parse({});
  const [result, cleaners] = await Promise.all([
    listBookings(user, q),
    can(user, "bookings:write") ? assignableCleaners(user) : can(user, "cleaners:read") ? listCleaners(user, { status: "all", page: 1, pageSize: 100 }).then((r) => r.items) : Promise.resolve([]),
  ]);
  const t = user.organization.terminology;
  const label = plural(t.booking);
  const keep: Record<string, string | undefined> = { status: q.status, from: q.from, to: q.to, cleanerId: q.cleanerId, customerId: q.customerId, city: q.city, unassigned: q.unassigned, q: q.q, dir: q.dir !== "asc" ? q.dir : undefined };
  const chips = [
    q.status ? ["status", `Status: ${BOOKING_STATUS_LABELS[q.status]}`] : null,
    q.from || q.to ? ["from", `Dates: ${q.from ?? "…"} → ${q.to ?? "…"}`] : null,
    q.cleanerId ? ["cleanerId", `Cleaner: ${cleaners.find((c) => c.id === q.cleanerId)?.name ?? "selected"}`] : null,
    q.customerId ? ["customerId", "One customer"] : null,
    q.city ? ["city", `Booked city: ${q.city}`] : null,
    q.unassigned ? ["unassigned", "Unassigned only"] : null,
    q.q ? ["q", `Reference: ${q.q}`] : null,
  ].filter(Boolean) as [string, string][];
  const without = (key: string) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(keep)) if (v && k !== key && !(key === "from" && k === "to")) sp.set(k, v);
    return `/dashboard/bookings${sp.size ? `?${sp}` : ""}`;
  };

  return (
    <>
      <PageHeader
        title={label}
        description={`Times shown in ${user.organization.timezone}. The city filter uses the address saved on each booking.`}
        actions={
          can(user, "bookings:write") ? (
            <LinkButton href="/dashboard/bookings/new">
              <CalendarPlus className="size-4" aria-hidden /> New {t.booking.toLowerCase()}
            </LinkButton>
          ) : null
        }
      />
      <Card>
        <form method="get" role="search" aria-label={`Filter ${label.toLowerCase()}`} className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">
            <span className="mb-1 block font-medium">From</span>
            <input type="date" name="from" defaultValue={q.from ?? ""} className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-base sm:text-sm" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">To</span>
            <input type="date" name="to" defaultValue={q.to ?? ""} className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-base sm:text-sm" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Status</span>
            <select name="status" defaultValue={q.status ?? ""} className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
              <option value="">Any status</option>
              {BOOKING_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {BOOKING_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Cleaner</span>
            <select name="cleanerId" defaultValue={q.cleanerId ?? ""} className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
              <option value="">Anyone</option>
              {cleaners.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Booked city</span>
            <input name="city" defaultValue={q.city ?? ""} maxLength={100} className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-base sm:text-sm" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Reference</span>
            <input name="q" defaultValue={q.q ?? ""} maxLength={40} placeholder="RP-…" className="h-10 w-full rounded-lg border border-line bg-surface px-3 text-base sm:text-sm" />
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" name="unassigned" value="1" defaultChecked={Boolean(q.unassigned)} className="size-4 accent-brand" /> Unassigned only
          </label>
          <div className="flex items-end gap-2">
            {q.customerId ? <input type="hidden" name="customerId" value={q.customerId} /> : null}
            <select name="dir" defaultValue={q.dir} aria-label="Sort order" className="h-10 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
              <option value="asc">Earliest first</option>
              <option value="desc">Latest first</option>
            </select>
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
            <Link href="/dashboard/bookings" className="text-xs font-medium text-muted underline">Reset all</Link>
          </div>
        ) : null}
        {result.items.length === 0 ? (
          <EmptyState icon={ClipboardList} title={chips.length ? `No ${label.toLowerCase()} match these filters` : `No ${label.toLowerCase()} yet`}>
            {chips.length ? "Try different filters." : can(user, "bookings:write") ? "Create a booking from here, the calendar or a customer profile." : null}
          </EmptyState>
        ) : (
          <BookingList bookings={result.items} timezone={user.organization.timezone} empty="" />
        )}
        <Pagination page={result.page} totalPages={result.totalPages} total={result.total} basePath="/dashboard/bookings" params={keep} />
      </Card>
    </>
  );
}
