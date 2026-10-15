import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { CallActions } from "@/components/calls/call-actions";
import { ConvertLeadPanel, LeadWorkflow } from "@/components/leads/lead-actions";
import { AccessDenied } from "@/components/shell/access";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { LEAD_CATEGORY_LABELS, LEAD_CHANNEL_LABELS, LEAD_STATUS_LABELS, RE_INTENT_LABELS, type ReIntent } from "@/lib/domain/leads";
import { isSafeHttpUrl } from "@/lib/domain/links";
import { formatCents } from "@/lib/domain/money";
import { formatDate, formatDateTime } from "@/lib/domain/time";
import { AppError } from "@/lib/http/errors";
import { assignableStaff, getLead } from "@/modules/leads/service";

export const metadata: Metadata = { title: "Lead" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className="col-span-2 break-words">{children || <span className="text-muted">—</span>}</dd>
    </div>
  );
}

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser(`/dashboard/leads/${id}`);
  if (!can(user, "leads:read")) return <AccessDenied />;
  const lead = await getLead(user, id).catch((e: unknown) => {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  });
  const staff = await assignableStaff(user);
  const tz = user.organization.timezone;
  const canWrite = can(user, "leads:write");
  const channel = LEAD_CHANNEL_LABELS[lead.channel as keyof typeof LEAD_CHANNEL_LABELS];
  return (
    <>
      <Link href={`/dashboard/leads?category=${lead.category}`} className="mb-3 inline-block text-sm font-medium text-brand hover:underline">
        ← {LEAD_CATEGORY_LABELS[lead.category]} leads
      </Link>
      <PageHeader
        title={lead.name}
        description={`${LEAD_CATEGORY_LABELS[lead.category]} lead · received ${formatDate(lead.receivedAt, tz)} · ${lead.source || channel}`}
        actions={<Badge tone={lead.status === "converted" ? "success" : lead.status === "lost" ? "slate" : "info"}>{LEAD_STATUS_LABELS[lead.status]}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Details" />
            <dl className="divide-y divide-line px-5 py-2 text-sm">
              {/* Leads have no call log target yet: dialer link and copy only. */}
              <Row label="Phone">{lead.phone ? <CallActions e164={lead.phone} display={lead.phoneDisplay} target={{ type: "customer", id: lead.id, name: lead.name }} canLog={false} browserCalling={false} /> : null}</Row>
              <Row label="Email">{lead.email ? <a className="text-brand hover:underline" href={`mailto:${lead.email}`}>{lead.email}</a> : null}</Row>
              <Row label="City">{lead.city}</Row>
              <Row label="Address">{lead.address}</Row>
              <Row label="Source">
                {lead.source} <span className="text-muted">({channel})</span>
              </Row>
              {lead.service ? (
                <>
                  <Row label="Requested service">{lead.service.requestedService}</Row>
                  <Row label="Preferred date">{lead.service.preferredDate ? formatDate(`${lead.service.preferredDate}T12:00:00Z`, "UTC") : null}</Row>
                  <Row label="Service location">{lead.service.serviceLocation}</Row>
                </>
              ) : null}
              {lead.realEstate ? (
                <>
                  <Row label="Looking to">{lead.realEstate.intent ? RE_INTENT_LABELS[lead.realEstate.intent as ReIntent] : null}</Row>
                  <Row label="Area of interest">{lead.realEstate.areaOfInterest}</Row>
                  <Row label="Budget">{lead.realEstate.budgetCents !== null ? formatCents(lead.realEstate.budgetCents, user.organization.currency) : null}</Row>
                  <Row label="Listing">
                    {lead.realEstate.listingUrl && isSafeHttpUrl(lead.realEstate.listingUrl) ? (
                      <a className="inline-flex items-center gap-1 text-brand hover:underline" href={lead.realEstate.listingUrl} target="_blank" rel="noopener noreferrer nofollow">
                        Open listing <ExternalLink className="size-3.5" aria-hidden />
                      </a>
                    ) : null}
                  </Row>
                </>
              ) : null}
              <Row label="Notes"><span className="whitespace-pre-wrap">{lead.notes}</span></Row>
            </dl>
          </Card>
          <Card>
            <CardHeader title="History" />
            <ol className="divide-y divide-line px-5 py-2 text-sm">
              {lead.history.map((h, i) => (
                <li key={i} className="py-2">
                  <p className="whitespace-pre-wrap">{h.text}</p>
                  <p className="text-xs text-muted">{formatDateTime(h.at, tz)} · {h.by}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <div className="space-y-6">
          {canWrite ? (
            <Card>
              <CardHeader title="Follow-up" />
              <div className="p-5">
                <LeadWorkflow leadId={lead.id} status={lead.status} assignedTo={lead.assignedTo?.id ?? null} staff={staff} />
              </div>
            </Card>
          ) : null}
          {canWrite && can(user, "customers:write") ? (
            <Card>
              <CardHeader title="Customer" description="Link this lead to an existing customer or create one." />
              <div className="p-5">
                <ConvertLeadPanel leadId={lead.id} category={lead.category} convertedCustomerId={lead.convertedCustomerId} preferredDate={lead.service?.preferredDate ?? null} canBook={can(user, "bookings:write")} />
              </div>
            </Card>
          ) : lead.convertedCustomerId && can(user, "customers:read") ? (
            <Card className="p-5 text-sm">
              <Link className="text-brand hover:underline" href={`/dashboard/customers/${lead.convertedCustomerId}`}>Open linked customer</Link>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
