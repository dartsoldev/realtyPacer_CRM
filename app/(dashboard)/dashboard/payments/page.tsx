import type { Metadata } from "next";
import { CreditCard } from "lucide-react";
import { AccessDenied, ModuleComingNext } from "@/components/shell/access";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";

export const metadata: Metadata = { title: "Payments" };

export default async function Page() {
  const user = await requirePageUser("/dashboard/payments");
  if (!can(user, "payments:read")) return <AccessDenied />;
  return (
    <ModuleComingNext
      title={"Payments"}
      icon={CreditCard}
      phase={3}
      description="Payments received from customers and how they apply to booked services."
      plans={[
        "Amounts, methods and dates",
        "Explicit allocation to booking line items",
        "Outstanding balances per customer",
      ]}
    />
  );
}
