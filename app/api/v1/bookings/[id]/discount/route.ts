import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { setDiscount } from "@/modules/finance/charges";

export const runtime = "nodejs";

/** Draft bookings only: { expectedVersion, type: none|fixed|percent, amountCents?, basisPoints? }. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("billing:finalize");
  return ok(await setDiscount(user, (await params).id, await readBody(req)));
});
