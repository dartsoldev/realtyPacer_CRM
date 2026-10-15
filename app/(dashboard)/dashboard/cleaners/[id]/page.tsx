import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookingList } from "@/components/ops/booking-list";
import { EmailLink } from "@/components/ops/contact";
import { CallActions } from "@/components/calls/call-actions";
import { browserCallingAvailable } from "@/modules/calls/service";
import { listCalls } from "@/modules/calls/service";
import { CALL_OUTCOME_LABELS, type CallOutcome } from "@/lib/domain/constants";
import { formatDateTime } from "@/lib/domain/time";
import { ActiveBadge } from "@/components/ops/status";
import { AccessDenied } from "@/components/shell/access";
import { Card, CardHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { AppError } from "@/lib/http/errors";
import { cleanerSchedule } from "@/modules/bookings/service";
import { getCleaner } from "@/modules/cleaners/service";
import { CleanerAccount, CleanerStateActions, EditCleanerButton } from "../cleaner-admin";

export const metadata: Metadata = { title: "Cleaner" };

export default async function CleanerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser(`/dashboard/cleaners/${id}`);
  if (!can(user, "cleaners:read")) return <AccessDenied />;
  let cleaner;
  try {
    cleaner = await getCleaner(user, id);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  const schedule = can(user, "bookings:read") ? await cleanerSchedule(user, cleaner.id) : null;
  const canWrite = can(user, "cleaners:write");
  const tz = user.organization.timezone;
  const calls = can(user, "calls:log") ? await listCalls(user, { cleanerId: cleaner.id }) : null;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted">
        <Link href="/dashboard/cleaners" className="underline-offset-4 hover:underline">Cleaners</Link> / <span className="text-ink">{cleaner.name}</span>
      </nav>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{cleaner.name}</h1>
            <ActiveBadge active={cleaner.active} archived={cleaner.archived} />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <CallActions e164={cleaner.phone} display={cleaner.phoneDisplay} target={{ type: "cleaner", id: cleaner.id, name: cleaner.name }} canLog={can(user, "calls:log")} browserCalling={browserCallingAvailable(user)} />
            <EmailLink email={cleaner.email} />
          </div>
          {cleaner.serviceAreas.length ? <p className="text-sm text-muted">Service areas: {cleaner.serviceAreas.join(", ")}</p> : null}
        </div>
        {canWrite ? <EditCleanerButton cleaner={cleaner} /> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Upcoming and in-progress jobs" />
            {schedule ? <BookingList bookings={schedule.upcoming} timezone={tz} empty="No upcoming jobs." /> : <p className="px-5 py-4 text-sm text-muted">You don’t have access to bookings.</p>}
          </Card>
          {calls ? (
            <Card>
              <CardHeader title="Calls" description="Logged calls and browser calls with this cleaner (latest 50)" />
              {calls.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">No calls logged.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {calls.map((c) => (
                    <li key={c.id} className="px-5 py-3 text-sm">
                      <p>
                        <span className="font-medium">{c.direction === "inbound" ? "Incoming" : "Outgoing"}{c.channel === "browser" ? " browser call" : " call"}</span>
                        {c.outcome ? ` — ${CALL_OUTCOME_LABELS[c.outcome as CallOutcome]}` : c.status !== "logged" ? ` — ${c.status.replace("_", " ")}` : ""}
                        {c.durationSeconds ? <span className="text-muted"> · {Math.max(1, Math.round(c.durationSeconds / 60))} min</span> : null}
                      </p>
                      {c.notes ? <p className="whitespace-pre-wrap">{c.notes}</p> : null}
                      <p className="text-xs text-muted">{c.actorName} · {formatDateTime(c.occurredAt, tz)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Recently completed" description="Last 25 completed jobs" />
            {schedule ? <BookingList bookings={schedule.completed} timezone={tz} empty="No completed jobs yet." /> : null}
          </Card>
        </div>
        <div className="space-y-6">
          {canWrite ? (
            <Card>
              <CardHeader title="Availability" description="Inactive cleaners can’t receive new assignments." />
              <div className="p-5">
                <CleanerStateActions cleaner={cleaner} timezone={tz} />
              </div>
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Sign-in account" />
            <div className="p-5">
              <CleanerAccount cleaner={cleaner} canInvite={canWrite && can(user, "users:invite")} canLink={canWrite && can(user, "users:manage")} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Internal notes" />
            <p className="whitespace-pre-wrap px-5 py-4 text-sm">{cleaner.notes || <span className="text-muted">No notes.</span>}</p>
          </Card>
        </div>
      </div>
    </>
  );
}
