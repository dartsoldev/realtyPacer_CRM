import type { Metadata } from "next";
import Link from "next/link";
import { CustomerFilter } from "@/components/reports/customer-filter";
import { AccessDenied } from "@/components/shell/access";
import { PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { conditionSchema, decodeDefinition, type Condition } from "@/modules/reports/definition";

export const metadata: Metadata = { title: "Customer filter" };

export default async function CustomerFilterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/customer-filter");
  if (!can(user, "reports:read") || !can(user, "customers:read")) return <AccessDenied />;
  const sp = await searchParams;
  let conditions: Condition[] = [];
  if (typeof sp.f === "string") {
    try {
      const parsed = conditionSchema.array().max(20).safeParse(decodeDefinition(sp.f));
      if (parsed.success) conditions = parsed.data;
    } catch {
      /* ignore malformed links */
    }
  }
  const columns = typeof sp.c === "string" ? sp.c.split(",").filter((c) => /^(?:phone|email|customerCity|tags|points|cf:cf_[a-z0-9]{8})$/.test(c)).slice(0, 20) : ["phone", ...(can(user, "loyalty:read") ? ["points"] : [])];
  return (
    <>
      <PageHeader
        title="Customer & service filter"
        description="Find customers by where and what was done — e.g. City is Mississauga AND Service is Sofa cleaning. Every filter must match."
        actions={<Link href="/dashboard/reports" className="text-sm font-medium text-brand underline-offset-4 hover:underline">Advanced reports</Link>}
      />
      <CustomerFilter initialConditions={conditions} initialColumns={columns} timezone={user.organization.timezone} currency={user.organization.currency} />
    </>
  );
}
