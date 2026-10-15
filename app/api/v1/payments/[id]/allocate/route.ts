import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { allocateCredit } from "@/modules/finance/payments";

export const runtime = "nodejs";

/** Apply unallocated credit: { expectedRevision, allocations: [{ bookingId, lineItemId, amountCents }] }. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("payments:allocate");
  return ok(await allocateCredit(user, (await params).id, await readBody(req)));
});
