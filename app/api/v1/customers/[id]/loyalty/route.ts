import { requireApiUser } from "@/lib/auth/current-user";
import { z } from "zod";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { addLoyaltyEntry, loyaltyHistory } from "@/modules/loyalty/service";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("loyalty:read");
  const q = parseQuery(req, z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) }));
  return ok(await loyaltyHistory(user, (await params).id, q.page));
});

/** { type: grant|redeem|correction|reversal, idempotencyKey, ... }. The balance is never edited directly. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("loyalty:adjust");
  const res = await addLoyaltyEntry(user, (await params).id, await readBody(req));
  return ok(res, res.created ? 201 : 200);
});
