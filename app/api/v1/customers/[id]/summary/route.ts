import { Types } from "mongoose";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { customerMetrics, getCustomer } from "@/modules/customers/service";

export const runtime = "nodejs";

/** Service metrics; definitions in PROJECT_STATE.md. No financial figures until phase 3. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("bookings:read");
  const customer = await getCustomer(user, (await params).id);
  const metrics = await customerMetrics(new Types.ObjectId(user.organizationId), new Types.ObjectId(customer.id), user.organization.timezone);
  return ok({ metrics, payments: { available: false, reason: "Payments are recorded starting in phase 3." } });
});
