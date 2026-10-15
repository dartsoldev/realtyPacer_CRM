import type { Metadata } from "next";
import { ReportBuilder } from "@/components/reports/report-builder";
import { AccessDenied } from "@/components/shell/access";
import { PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { decodeDefinition, reportDefinitionSchema, resolveDatePreset, type ReportDefinition, type ReportMode } from "@/modules/reports/definition";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/reports");
  if (!can(user, "reports:read")) return <AccessDenied />;
  const tz = user.organization.timezone;
  const modes: ReportMode[] = ["service", "customers", ...(can(user, "financials:read") && can(user, "pricing:read") ? (["cash"] as const) : [])];

  const month = resolveDatePreset("this_month", tz)!;
  let initial: ReportDefinition = { mode: "service", datePreset: "this_month", ...month, statuses: ["COMPLETED"], filters: { logic: "and", conditions: [] } };
  const d = (await searchParams).d;
  if (typeof d === "string") {
    // A link only restores filter settings; the server re-checks access on every run.
    try {
      const parsed = reportDefinitionSchema.safeParse(decodeDefinition(d));
      if (parsed.success && modes.includes(parsed.data.mode)) {
        initial = parsed.data;
        const r = initial.datePreset !== "custom" ? resolveDatePreset(initial.datePreset, tz) : null;
        if (r) initial = { ...initial, ...r };
      }
    } catch {
      /* ignore malformed links */
    }
  }

  return (
    <>
      <PageHeader
        title="Reports"
        description={`Combine filters across services, bookings, customers and payments. Dates use ${tz}. Every condition must match (AND); several values in one condition match any of them.`}
      />
      <ReportBuilder modes={modes} initial={initial} timezone={tz} currency={user.organization.currency} canExport={can(user, "reports:export")} canShare={can(user, "views:share")} />
    </>
  );
}
