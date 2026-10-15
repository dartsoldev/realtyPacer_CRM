import type { Metadata } from "next";
import { CustomerForm } from "@/components/ops/customer-form";
import { AccessDenied } from "@/components/shell/access";
import { Card, PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";

export const metadata: Metadata = { title: "New customer" };

export default async function NewCustomerPage() {
  const user = await requirePageUser("/dashboard/customers/new");
  if (!can(user, "customers:write")) return <AccessDenied />;
  return (
    <>
      <PageHeader title={`New ${user.organization.terminology.customer.toLowerCase()}`} description="Customers are contact records only — no sign-in account or invitation is created." />
      <Card className="p-5 sm:p-6">
        <CustomerForm mode="create" />
      </Card>
    </>
  );
}
