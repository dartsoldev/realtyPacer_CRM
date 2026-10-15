import type { Metadata } from "next";
import Link from "next/link";
import { Inbox, Search } from "lucide-react";
import { AddLeadButton, LeadImportButton } from "@/components/leads/lead-actions";
import { AccessDenied } from "@/components/shell/access";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Pagination } from "@/components/ui/pagination";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { LEAD_CATEGORY_LABELS, LEAD_CHANNEL_LABELS, LEAD_STATUS_LABELS, type LeadStatus } from "@/lib/domain/leads";
import { formatDate } from "@/lib/domain/time";
import { assignableStaff, leadListQuery, listLeads } from "@/modules/leads/service";

export const metadata: Metadata = { title: "Leads" };

const LEAD_STATUS_TONE: Record<LeadStatus, "info" | "pending" | "purple" | "success" | "slate"> = { new: "info", contacted: "pending", qualified: "purple", converted: "success", lost: "slate" };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/leads");
  if (!can(user, "leads:read")) return <AccessDenied />;
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v)) as Record<string, string>;
  const parsed = leadListQuery.safeParse(raw);
  const q = parsed.success ? parsed.data : leadListQuery.parse({});
  const [result, staff] = await Promise.all([listLeads(user, q), assignableStaff(user)]);
  const canWrite = can(user, "leads:write");
  const tz = user.organization.timezone;
  const keep = { category: q.category, status: q.status !== "open" ? q.status : undefined, q: q.q };
  const statusHref = (s: string) => {
    const sp = new URLSearchParams({ category: q.category });
    if (s !== "open") sp.set("status", s);
    if (q.q) sp.set("q", q.q);
    return `/dashboard/leads?${sp}`;
  };

  return (
    <>
      <PageHeader
        title="Leads"
        description="Potential customers in two separate categories. Category is what they want; source is where they came from."
        actions={
          canWrite ? (
            <div className="flex flex-wrap gap-2">
              <LeadImportButton category={q.category} />
              <AddLeadButton defaultCategory={q.category} staff={staff} />
            </div>
          ) : null
        }
      />
      <nav aria-label="Lead categories" className="mb-4 flex gap-2 border-b border-line">
        {(["general", "real_estate"] as const).map((c) => {
          const active = q.category === c;
          const count = c === "general" ? result.counts.generalNew : result.counts.realEstateNew;
          return (
            <Link
              key={c}
              href={`/dashboard/leads?category=${c}`}
              aria-current={active ? "page" : undefined}
              className={`-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium ${active ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink"}`}
            >
              {LEAD_CATEGORY_LABELS[c]}
              {count ? <Badge tone="info">{count} new</Badge> : null}
            </Link>
          );
        })}
      </nav>
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
          <form className="flex min-w-[16rem] flex-1 items-center gap-2" role="search" action="/dashboard/leads">
            <input type="hidden" name="category" value={q.category} />
            {q.status !== "open" ? <input type="hidden" name="status" value={q.status} /> : null}
            <label htmlFor="lead-q" className="sr-only">Search leads</label>
            <input id="lead-q" name="q" defaultValue={q.q ?? ""} placeholder="Name, phone or email" className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm" />
            <button className={buttonClasses("secondary")} type="submit">
              <Search className="size-4" aria-hidden /> Search
            </button>
          </form>
          <div className="flex flex-wrap gap-1 text-sm" role="group" aria-label="Status">
            {["open", "new", "contacted", "qualified", "converted", "lost", "all"].map((s) => (
              <Link key={s} href={statusHref(s)} aria-current={q.status === s ? "true" : undefined} className={`rounded-full px-3 py-1.5 ${q.status === s ? "bg-ink text-white" : "bg-canvas text-ink hover:bg-line"}`}>
                {s === "open" ? "Open" : s === "all" ? "All" : LEAD_STATUS_LABELS[s as LeadStatus]}
              </Link>
            ))}
          </div>
        </div>
        {result.items.length === 0 ? (
          <EmptyState icon={Inbox} title={q.q ? "No leads match your search" : `No ${LEAD_CATEGORY_LABELS[q.category].toLowerCase()} leads here`}>
            Add a lead, import a CSV, or connect a website form under Settings → Integrations.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-5 py-2.5">Name</th>
                  <th scope="col" className="px-3 py-2.5">Contact</th>
                  <th scope="col" className="px-3 py-2.5">{q.category === "general" ? "Requested" : "Looking for"}</th>
                  <th scope="col" className="px-3 py-2.5">City</th>
                  <th scope="col" className="px-3 py-2.5">Source</th>
                  <th scope="col" className="px-3 py-2.5">Received</th>
                  <th scope="col" className="px-3 py-2.5">Assigned</th>
                  <th scope="col" className="px-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.items.map((l) => (
                  <tr key={l.id} className="hover:bg-canvas/60">
                    <td className="px-5 py-3">
                      <Link href={`/dashboard/leads/${l.id}`} className="font-medium underline-offset-4 hover:underline">{l.name}</Link>
                    </td>
                    <td className="px-3 py-3 text-muted">{[l.phoneDisplay, l.email].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="px-3 py-3">{l.summary || <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-3 text-muted">{l.city || "—"}</td>
                    <td className="px-3 py-3 text-muted">
                      {l.source || "—"}
                      <span className="block text-xs">{LEAD_CHANNEL_LABELS[l.channel as keyof typeof LEAD_CHANNEL_LABELS]}</span>
                    </td>
                    <td className="px-3 py-3 text-muted">{formatDate(l.receivedAt, tz)}</td>
                    <td className="px-3 py-3">{l.assignedTo?.name ?? <Badge tone="pending">Unassigned</Badge>}</td>
                    <td className="px-3 py-3"><Badge tone={LEAD_STATUS_TONE[l.status]}>{LEAD_STATUS_LABELS[l.status]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={result.page} totalPages={result.totalPages} total={result.total} basePath="/dashboard/leads" params={keep} />
      </Card>
    </>
  );
}
