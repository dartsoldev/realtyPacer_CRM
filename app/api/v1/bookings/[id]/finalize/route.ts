import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { finalizeCharges } from "@/modules/finance/charges";

export const runtime = "nodejs";

/** DRAFT → FINALIZED (creates the amount owed; snapshots tax). Body: { expectedVersion }. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("billing:finalize");
  return ok(await finalizeCharges(user, (await params).id, await readBody(req)));
});
