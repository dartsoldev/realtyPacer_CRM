import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { AccessDenied, ModuleComingNext } from "@/components/shell/access";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";

export const metadata: Metadata = { title: "Reports" };

export default async function Page() {
  const user = await requirePageUser("/dashboard/reports");
  if (!can(user, "reports:read")) return <AccessDenied />;
  return (
    <ModuleComingNext
      title={"Reports"}
      icon={BarChart3}
      phase={3}
      description="Filtered reports across customers, bookings and payments."
      plans={[
        "Combined filters such as city AND service AND date",
        "Matching customers, bookings, service amounts and allocated payments",
        "Totals and export",
      ]}
    />
  );
}
