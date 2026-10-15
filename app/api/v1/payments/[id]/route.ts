import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { getPayment } from "@/modules/finance/payments";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("financials:read");
  return ok(await getPayment(user, (await params).id));
});
