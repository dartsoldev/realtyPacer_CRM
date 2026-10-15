import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { listPayments, paymentListQuery, recordPayment } from "@/modules/finance/payments";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("financials:read");
  return ok(await listPayments(user, parseQuery(req, paymentListQuery)));
});

/** Manual receipt (no card data). Idempotent on idempotencyKey: replays return 200 with the original id. */
export const POST = route(async (req) => {
  const user = await requireApiUser("payments:record");
  const res = await recordPayment(user, await readBody(req));
  return ok(res, res.created ? 201 : 200);
});
