import { requireApiUser } from "@/lib/auth/current-user";
import { Types } from "mongoose";
import { ok, route } from "@/lib/http/api";
import { customerFinancialSummary, reconcileCustomer } from "@/modules/finance/summary";

export const runtime = "nodejs";

/** Checks every financial invariant for one customer (diagnostic). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("financials:read");
  const { id } = await params;
  await customerFinancialSummary(user, id); // org scope + permission
  const r = await reconcileCustomer(new Types.ObjectId(user.organizationId), new Types.ObjectId(id));
  return ok({ ok: r.ok, issues: r.issues });
});
