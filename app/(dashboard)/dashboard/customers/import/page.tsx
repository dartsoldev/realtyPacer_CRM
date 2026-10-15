import type { Metadata } from "next";
import Link from "next/link";
import { CustomerImport } from "@/components/ops/customer-import";
import { AccessDenied } from "@/components/shell/access";
import { PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";

export const metadata: Metadata = { title: "Import customers" };

export default async function ImportCustomersPage() {
  const user = await requirePageUser("/dashboard/customers/import");
  if (!can(user, "customers:import") || !can(user, "customers:write")) return <AccessDenied />;
  return (
    <>
      <PageHeader
        title="Import customers"
        description="Bring existing customers in from a spreadsheet. You’ll match columns, review every row, and decide what happens to possible duplicates before anything is saved."
        actions={<Link href="/dashboard/customers" className="text-sm font-medium text-brand underline-offset-4 hover:underline">Back to customers</Link>}
      />
      <CustomerImport />
    </>
  );
}
