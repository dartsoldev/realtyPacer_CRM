import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { reversePayment } from "@/modules/finance/payments";

export const runtime = "nodejs";

/** Marks a mistaken receipt REVERSED (kept for history). Body: { expectedRevision, reason }. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("payments:refund");
  return ok(await reversePayment(user, (await params).id, await readBody(req)));
});
