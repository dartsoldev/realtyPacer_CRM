import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { recordRefund } from "@/modules/finance/payments";

export const runtime = "nodejs";

/** Records a refund already processed outside RealtyPacer (nothing is sent). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("payments:refund");
  const res = await recordRefund(user, (await params).id, await readBody(req));
  return ok(res, res.created ? 201 : 200);
});
