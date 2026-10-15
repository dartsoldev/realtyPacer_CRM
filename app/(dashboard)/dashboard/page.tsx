import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, CalendarPlus, CheckCircle2, PlayCircle, UserPlus, UserX, type LucideIcon } from "lucide-react";
import { BookingList } from "@/components/ops/booking-list";
import { JobCards } from "@/components/ops/my-jobs";
import { AccessDenied } from "@/components/shell/access";
import { plural } from "@/components/shell/nav-config";
import { Alert } from "@/components/ui/alert";
import { buttonClasses, LinkButton } from "@/components/ui/button";
import { Card, CardHeader, PageHeader } from "@/components/ui/layout";
import { can, type CurrentUser } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { formatDate } from "@/lib/domain/time";
import { isDateKey } from "@/lib/domain/zoned-time";
import { myJobs, operationsSummary } from "@/modules/bookings/service";
import { getDashboardSummary } from "@/modules/dashboard/service";
import { financialCards } from "@/modules/finance/dashboard";
import { encodeDefinition } from "@/modules/reports/definition";
import { formatCents } from "@/lib/domain/money";

export const metadata: Metadata = { title: "Dashboard" };

function reportLink(mode: "service" | "cash", month: { from: string; to: string }) {
  const def = { mode, datePreset: "this_month", ...month, statuses: ["COMPLETED"], filters: { logic: "and", conditions: [] } };
  return `/dashboard/reports?d=${encodeDefinition(def)}`;
}

function MoneyLink({ label, cents, currency, href, note }: { label: string; cents: number; currency: string; href: string; note: string }) {
  return (
    <Link href={href} className="block rounded-xl border border-line bg-surface p-5 shadow-sm transition-colors hover:border-brand/40">
      <span className="text-sm font-medium text-muted">{label}</span>
      <span className="mt-2 block text-2xl font-semibold tabular-nums">{formatCents(cents, currency)}</span>
      <span className="mt-1 block text-xs text-muted">{note}</span>
    </Link>
  );
}

function StatLink({ label, value, icon: Icon, href, note }: { label: string; value: number; icon: LucideIcon; href: string; note?: string }) {
  return (
    <Link href={href} className="block rounded-xl border border-line bg-surface p-5 shadow-sm transition-colors hover:border-brand/40">
      <span className="flex items-center justify-between">
        <span className="text-sm font-medium text-muted">{label}</span>
        <Icon className="size-5 text-muted" aria-hidden />
      </span>
      <span className="mt-2 block text-3xl font-semibold tabular-nums">{value}</span>
      {note ? <span className="mt-1 block text-xs text-muted">{note}</span> : null}
    </Link>
  );
}

async function CleanerWorkspace({ user }: { user: CurrentUser }) {
  const data = await myJobs(user);
  const tz = user.organization.timezone;
  return (
    <>
      <PageHeader title="My jobs" description={`Your assigned jobs from today. Times in ${tz}.`} />
      {!data.linked ? (
        <Alert tone="info" title="Your account isn’t linked to a cleaner profile yet">Ask an administrator to link your sign-in to your cleaner profile.</Alert>
      ) : data.jobs.length === 0 ? (
        <Card className="p-6 text-sm text-muted">No upcoming jobs are assigned to you.</Card>
      ) : (
        <JobCards jobs={data.jobs} timezone={tz} />
      )}
      {data.recent.length ? (
        <Card className="mt-6">
          <CardHeader title="Recently completed" />
          <BookingList bookings={data.recent} timezone={tz} empty="" />
        </Card>
      ) : null}
    </>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard");
  if (!can(user, "dashboard:view")) return <AccessDenied />;
  if (!can(user, "bookings:read") && can(user, "bookings:read_assigned")) return <CleanerWorkspace user={user} />;

  const sp = await searchParams;
  const from = typeof sp.from === "string" && isDateKey(sp.from) ? sp.from : undefined;
  const to = typeof sp.to === "string" && isDateKey(sp.to) ? sp.to : undefined;
  const t = user.organization.terminology;
  const firstName = user.name.split(" ")[0];
  const tz = user.organization.timezone;

  const fin = can(user, "financials:read") && can(user, "pricing:read") && can(user, "reports:read") ? await financialCards(user) : null;
  const [ops, admin] = await Promise.all([can(user, "bookings:read") ? operationsSummary(user, { from, to }).catch((e) => (e?.code === "VALIDATION_ERROR" ? operationsSummary(user, {}) : Promise.reject(e))) : null, getDashboardSummary(user)]);

  return (
    <>
      <PageHeader
        title={`Welcome, ${firstName}`}
        description={`Today is ${ops ? formatDate(`${ops.today}T12:00:00Z`, "UTC") : formatDate(new Date(), tz)} in ${tz}.`}
        actions={
          <div className="flex flex-wrap gap-2">
            {can(user, "bookings:write") ? (
              <LinkButton href="/dashboard/bookings/new">
                <CalendarPlus className="size-4" aria-hidden /> New {t.booking.toLowerCase()}
              </LinkButton>
            ) : null}
            {can(user, "customers:write") ? (
              <LinkButton href="/dashboard/customers/new" variant="secondary">
                <UserPlus className="size-4" aria-hidden /> New {t.customer.toLowerCase()}
              </LinkButton>
            ) : null}
          </div>
        }
      />

      {ops ? (
        <>
          <section aria-labelledby="ops-h" className="space-y-3">
            <h2 id="ops-h" className="text-sm font-semibold uppercase tracking-wide text-muted">{plural(t.booking)} (count of jobs)</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatLink label="Today" value={ops.todayCount} icon={CalendarClock} href={`/dashboard/bookings?from=${ops.today}&to=${ops.today}`} note="Not cancelled" />
              <StatLink label="Tomorrow" value={ops.tomorrowCount} icon={CalendarClock} href={`/dashboard/bookings?from=${ops.tomorrow}&to=${ops.tomorrow}`} note="Not cancelled" />
              <StatLink label="Unassigned upcoming" value={ops.unassignedUpcoming} icon={UserX} href="/dashboard/bookings?unassigned=1&status=SCHEDULED" note="Scheduled with no cleaner" />
              <StatLink label="In progress" value={ops.inProgress} icon={PlayCircle} href="/dashboard/bookings?status=IN_PROGRESS" />
            </div>
          </section>

          <section aria-labelledby="done-h" className="mt-8 space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="done-h" className="text-sm font-semibold uppercase tracking-wide text-muted">
                Completed {formatDate(`${ops.completed.from}T12:00:00Z`, "UTC")} – {formatDate(`${ops.completed.to}T12:00:00Z`, "UTC")}
              </h2>
              <form method="get" className="flex flex-wrap items-end gap-2 text-sm" aria-label="Completed jobs date range">
                <label>
                  <span className="mb-1 block text-xs font-medium">From</span>
                  <input type="date" name="from" defaultValue={ops.completed.from} className="h-9 rounded-lg border border-line bg-surface px-2 text-base sm:text-sm" />
                </label>
                <label>
                  <span className="mb-1 block text-xs font-medium">To</span>
                  <input type="date" name="to" defaultValue={ops.completed.to} className="h-9 rounded-lg border border-line bg-surface px-2 text-base sm:text-sm" />
                </label>
                <button type="submit" className={buttonClasses("secondary", "sm")}>Show</button>
              </form>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatLink label="Completed bookings" value={ops.completed.bookings} icon={CheckCircle2} href={`/dashboard/bookings?status=COMPLETED&from=${ops.completed.from}&to=${ops.completed.to}`} note="Jobs" />
              <StatLink label="Service items completed" value={ops.completed.serviceItems} icon={CheckCircle2} href={`/dashboard/bookings?status=COMPLETED&from=${ops.completed.from}&to=${ops.completed.to}`} note="Sum of item quantities" />
              <StatLink label="Unique customers served" value={ops.completed.uniqueCustomers} icon={CheckCircle2} href={`/dashboard/bookings?status=COMPLETED&from=${ops.completed.from}&to=${ops.completed.to}`} note="Distinct customers" />
            </div>
          </section>

          {fin ? (
            <section aria-labelledby="fin-h" className="mt-8 space-y-3">
              <h2 id="fin-h" className="text-sm font-semibold uppercase tracking-wide text-muted">Money ({fin.currency})</h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MoneyLink label="Net cash received this month" cents={fin.cashThisMonth.netCents} currency={fin.currency} href={reportLink("cash", fin.month)} note={`${formatCents(fin.cashThisMonth.receiptsCents, fin.currency)} received − ${formatCents(fin.cashThisMonth.refundsCents, fin.currency)} refunded · ${fin.cashThisMonth.basis}`} />
                <MoneyLink label="Outstanding now" cents={fin.outstandingNow.cents} currency={fin.currency} href={`/dashboard/customers?f=${encodeDefinition([{ field: "customerOutstanding", op: "gt", value: 0 }])}`} note={`${fin.outstandingNow.bookings} bookings · ${fin.outstandingNow.basis}`} />
                <MoneyLink label="Unapplied customer credit" cents={fin.creditNow.cents} currency={fin.currency} href="/dashboard/payments?unallocated=1" note={fin.creditNow.basis} />
                <MoneyLink label="Completed work charged this month" cents={fin.completedChargedThisMonth.cents} currency={fin.currency} href={reportLink("service", fin.month)} note={fin.completedChargedThisMonth.basis} />
              </div>
            </section>
          ) : null}

          <div className="mt-8 grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader title="Today’s jobs" actions={<Link href="/dashboard/calendar" className="text-sm font-medium text-brand underline-offset-4 hover:underline">Calendar</Link>} />
              <BookingList bookings={ops.todayJobs} timezone={tz} empty="No jobs today." />
            </Card>
            <Card>
              <CardHeader title="Upcoming jobs" description="Next scheduled jobs" actions={<Link href="/dashboard/bookings?status=SCHEDULED" className="text-sm font-medium text-brand underline-offset-4 hover:underline">All</Link>} />
              <BookingList bookings={ops.upcoming} timezone={tz} empty="Nothing scheduled." />
            </Card>
          </div>
        </>
      ) : (
        <Card className="p-6 text-sm text-muted">You don’t have access to operational data. Ask an administrator if you need it.</Card>
      )}

      {admin.users ? (
        <p className="mt-8 text-sm text-muted">
          Team: {admin.users.active} active, {admin.users.invited} invited, {admin.users.suspended} suspended ·{" "}
          <Link href="/dashboard/users" className="underline">Manage users</Link>
        </p>
      ) : null}
    </>
  );
}
