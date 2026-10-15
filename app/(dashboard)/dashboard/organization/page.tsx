import type { Metadata } from "next";
import { AccessDenied } from "@/components/shell/access";
import { PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { getOrganizationSettings } from "@/modules/organization/service";
import { OrganizationForm } from "./organization-form";
import { TaxSettings } from "./tax-settings";
import { NotificationSettings } from "./notification-settings";
import { getConfigStatus } from "@/lib/env";

export const metadata: Metadata = { title: "Organization" };

export default async function OrganizationPage() {
  const user = await requirePageUser("/dashboard/organization");
  if (!can(user, "organization:read")) return <AccessDenied />;
  const settings = await getOrganizationSettings(user);
  return (
    <>
      <PageHeader title="Organization" description="Business identity, contact details and the labels used across the app." />
      <OrganizationForm
        settings={settings}
        canEdit={can(user, "organization:update")}
        canEditProtected={can(user, "organization:update_protected")}
      />
      <TaxSettings tax={settings.tax} canEdit={can(user, "organization:update_protected")} />
      <NotificationSettings value={settings.notifications.customerBookingEmails} canEdit={can(user, "organization:update")} emailConfigured={getConfigStatus("smtp").ok} />
    </>
  );
}
