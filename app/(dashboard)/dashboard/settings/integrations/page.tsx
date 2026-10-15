import type { Metadata } from "next";
import { GoogleCalendarCard } from "@/components/integrations/google-calendar-card";
import { LeadSourcesCard } from "@/components/integrations/lead-sources-card";
import { AccessDenied } from "@/components/shell/access";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { getCoreEnv } from "@/lib/env";
import { CALLBACK_PATH, googleStatus } from "@/modules/integrations/google-calendar";
import { listLeadSources } from "@/modules/leads/intake";

export const metadata: Metadata = { title: "Integrations" };

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/settings/integrations");
  if (!can(user, "integrations:manage")) return <AccessDenied />;
  const sp = await searchParams;
  const [status, sources] = await Promise.all([googleStatus(user), listLeadSources(user)]);
  const googleError = typeof sp.google_error === "string" ? sp.google_error.slice(0, 40) : undefined;
  return (
    <>
      <PageHeader title="Integrations" description="Connections to outside services. Only what is listed as connected here is actually running." />
      <div className="space-y-6">
        <Card id="google-calendar">
          <CardHeader title="Google Calendar" description="Put scheduled bookings on a Google calendar." />
          <GoogleCalendarCard status={{ ...status, redirectUri: `${getCoreEnv().APP_URL}${CALLBACK_PATH}` }} flash={{ ok: sp.google === "connected", error: googleError }} timeZone={user.organization.timezone} />
        </Card>
        <Card id="lead-sources">
          <CardHeader title="Website lead forms" description="Receive leads from your website forms through a secure server-to-server endpoint." />
          <LeadSourcesCard sources={sources} timeZone={user.organization.timezone} />
        </Card>
        <Card>
          <CardHeader title="Other lead channels" />
          <ul className="divide-y divide-line px-5 py-2 text-sm">
            {["Gmail inbox", "Meta (Facebook/Instagram) Lead Ads", "Property portals (e.g. Realtor.ca, Zillow)"].map((n) => (
              <li key={n} className="flex items-center justify-between gap-3 py-2">
                <span>{n}</span>
                <Badge tone="slate">Not connected — not available</Badge>
              </li>
            ))}
          </ul>
          <p className="px-5 pb-4 text-xs text-muted">Leads from these channels can be added manually or with CSV import on the Leads page, or relayed to a website lead form source by a tool such as Zapier.</p>
        </Card>
      </div>
    </>
  );
}
