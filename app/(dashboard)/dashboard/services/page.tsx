import type { Metadata } from "next";
import { Search, Sparkles } from "lucide-react";
import { ActiveBadge } from "@/components/ops/status";
import { AccessDenied } from "@/components/shell/access";
import { buttonClasses } from "@/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Pagination } from "@/components/ui/pagination";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { formatMinutes } from "@/lib/domain/duration";
import { formatCents } from "@/lib/domain/money";
import { listServices, serviceListQuery } from "@/modules/catalog/service";
import { NewServiceButton, ServiceRowActions } from "./service-admin";

export const metadata: Metadata = { title: "Services" };

export default async function ServicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/services");
  if (!can(user, "services:read")) return <AccessDenied />;
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v));
  const parsed = serviceListQuery.safeParse(raw);
  const q = parsed.success ? parsed.data : serviceListQuery.parse({});
  const result = await listServices(user, q);
  const canWrite = can(user, "services:write") && can(user, "pricing:read");
  const currency = user.organization.currency;

  return (
    <>
      <PageHeader
        title="Services"
        description="Your catalog. Bookings copy each service’s name, price, unit and duration when added, so later edits never change past bookings."
        actions={canWrite ? <NewServiceButton currency={currency} /> : null}
      />
      <Card>
        <form method="get" role="search" aria-label="Filter services" className="flex flex-wrap items-end gap-3 border-b border-line p-4">
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
              <option value="all">All</option>
            </select>
          </label>
          <button type="submit" className={buttonClasses("secondary", "sm", "h-10")}>Apply</button>
        </form>
        {result.items.length === 0 ? (
          <EmptyState icon={Sparkles} title={q.q || q.status !== "active" ? "No services match" : "No services yet"}>
            {canWrite ? "Add the services you offer, e.g. sofa or carpet cleaning, with a default price and duration." : "Services added by an administrator will appear here."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {result.items.map((s) => (
              <li key={s.id} className="grid gap-2 px-5 py-4 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{s.name}</p>
                    <ActiveBadge active={s.active} />
                    {s.category ? <span className="text-xs text-muted">{s.category}</span> : null}
                  </div>
                  <p className="text-muted">
                    {s.defaultPriceCents !== null ? `${formatCents(s.defaultPriceCents, s.currency)} per ${s.unitLabel}` : `Per ${s.unitLabel}`} · {formatMinutes(s.durationMinutes)} each
                  </p>
                  {s.description ? <p className="text-muted">{s.description}</p> : null}
                </div>
                {canWrite ? <ServiceRowActions service={s} currency={currency} /> : null}
              </li>
            ))}
          </ul>
        )}
        <Pagination page={result.page} totalPages={result.totalPages} total={result.total} basePath="/dashboard/services" params={{ q: q.q, status: q.status !== "active" ? q.status : undefined }} />
      </Card>
    </>
  );
}
