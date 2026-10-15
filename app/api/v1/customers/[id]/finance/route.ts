import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { openCharges } from "@/modules/finance/payments";
import { customerFinanceHistory, customerFinancialSummary } from "@/modules/finance/summary";

export const runtime = "nodejs";

/** Lifetime summary (from authoritative records), charge and payment history, open charges. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("financials:read");
  const { id } = await params;
  const [summary, history, open] = await Promise.all([customerFinancialSummary(user, id), customerFinanceHistory(user, id), openCharges(user, id)]);
  return ok({ summary, ...history, openCharges: open });
});
