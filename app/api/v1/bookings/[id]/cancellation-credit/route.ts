import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { creditCancelledBooking } from "@/modules/finance/charges";

export const runtime = "nodejs";

/** Credits the unpaid balance of a cancelled, finalized booking. Never refunds money. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("billing:adjust");
  return ok(await creditCancelledBooking(user, (await params).id, await readBody(req)));
});
