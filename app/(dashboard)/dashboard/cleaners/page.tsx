import type { Metadata } from "next";
import Link from "next/link";
import { Briefcase, Search } from "lucide-react";
import { CallActions } from "@/components/calls/call-actions";
import { browserCallingAvailable } from "@/modules/calls/service";
import { ActiveBadge } from "@/components/ops/status";
import { AccessDenied } from "@/components/shell/access";
import { plural } from "@/components/shell/nav-config";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Pagination } from "@/components/ui/pagination";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { cleanerListQuery, listCleaners } from "@/modules/cleaners/service";
import { NewCleanerButton } from "./cleaner-admin";

export const metadata: Metadata = { title: "Cleaners" };

export default async function CleanersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/cleaners");
  if (!can(user, "cleaners:read")) return <AccessDenied />;
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v));
  const parsed = cleanerListQuery.safeParse(raw);
  const q = parsed.success ? parsed.data : cleanerListQuery.parse({});
  const result = await listCleaners(user, q);
  const label = plural(user.organization.terminology.provider);

  return (
    <>
      <PageHeader title={label} description="The people who perform your services. A profile doesn’t give sign-in access unless you explicitly invite them." actions={can(user, "cleaners:write") ? <NewCleanerButton /> : null} />
      <Card>
        <form method="get" role="search" aria-label={`Filter ${label.toLowerCase()}`} className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <label className="min-w-52 flex-1 text-sm">
            <span className="mb-1 block font-medium">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <input name="q" defaultValue={q.q ?? ""} maxLength={100} className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-base sm:text-sm" />
            </span>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Status</span>
            <select name="status" defaultValue={q.status} className="h-10 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </label>
          <button type="submit" className={buttonClasses("secondary", "sm", "h-10")}>Apply</button>
        </form>
        {result.items.length === 0 ? (
          <EmptyState icon={Briefcase} title={`No ${label.toLowerCase()} found`}>
            {can(user, "cleaners:write") ? "Add the people who perform your services so they can be assigned to bookings." : null}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {result.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/dashboard/cleaners/${c.id}`} className="font-semibold underline-offset-4 hover:underline">
                      {c.name}
                    </Link>
                    <ActiveBadge active={c.active} archived={c.archived} />
                    {c.linkedUser ? <Badge tone="teal">Can sign in</Badge> : null}
                  </div>
                  <div className="flex flex-wrap gap-x-4 text-muted">
                    <CallActions e164={c.phone} display={c.phoneDisplay} target={{ type: "cleaner", id: c.id, name: c.name }} canLog={can(user, "calls:log")} browserCalling={browserCallingAvailable(user)} compact />
                    {c.serviceAreas.length ? <span>Areas: {c.serviceAreas.join(", ")}</span> : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Pagination page={result.page} totalPages={result.totalPages} total={result.total} basePath="/dashboard/cleaners" params={{ q: q.q, status: q.status !== "active" ? q.status : undefined }} />
      </Card>
    </>
  );
}
