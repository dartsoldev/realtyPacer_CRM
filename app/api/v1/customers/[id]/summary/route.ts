import { Types } from "mongoose";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { customerMetrics, getCustomer } from "@/modules/customers/service";
import { customerFinancialSummary } from "@/modules/finance/summary";

export const runtime = "nodejs";

/** Service metrics, plus the lifetime financial summary when the caller may see money (definitions in PROJECT_STATE.md). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("bookings:read");
  const customer = await getCustomer(user, (await params).id);
  const metrics = await customerMetrics(new Types.ObjectId(user.organizationId), new Types.ObjectId(customer.id), user.organization.timezone);
  const financials = user.permissions.has("financials:read") ? await customerFinancialSummary(user, customer.id) : null;
  return ok({ metrics, financials });
});
