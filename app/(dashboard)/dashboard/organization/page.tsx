import type { Metadata } from "next";
import { AccessDenied } from "@/components/shell/access";
import { PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { getOrganizationSettings } from "@/modules/organization/service";
import { OrganizationForm } from "./organization-form";

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
    </>
  );
}
