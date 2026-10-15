import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CustomerForm } from "@/components/ops/customer-form";
import { AccessDenied } from "@/components/shell/access";
import { Card, PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { AppError } from "@/lib/http/errors";
import { getCustomer } from "@/modules/customers/service";
import { customFieldDefsFor } from "@/modules/custom-fields/service";

export const metadata: Metadata = { title: "Edit customer" };

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser(`/dashboard/customers/${id}/edit`);
  if (!can(user, "customers:write")) return <AccessDenied />;
  let c;
  try {
    c = await getCustomer(user, id);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  const cfDefs = await customFieldDefsFor(user.organizationId, "customer");
  return (
    <>
      <PageHeader
        title={`Edit ${c.name}`}
        description="Service addresses are managed on the profile’s Service addresses tab."
        actions={<Link href={`/dashboard/customers/${c.id}`} className="text-sm font-medium text-brand underline-offset-4 hover:underline">Back to profile</Link>}
      />
      <Card className="p-5 sm:p-6">
        <CustomerForm
          mode="edit"
          initial={{
            id: c.id,
            customerType: c.customerType,
            firstName: c.firstName,
            lastName: c.lastName,
            displayName: c.customerType === "individual" ? "" : c.name,
            companyName: c.companyName,
            phone: c.phoneDisplay ?? "",
            email: c.email ?? "",
            relationshipStartedAt: c.relationshipStartedAt ?? "",
            contactSource: c.contactSource ?? "",
            tags: c.tags,
            notes: c.notes,
            customFields: c.customFields,
          }}
          customFieldDefs={cfDefs}
        />
      </Card>
    </>
  );
}
