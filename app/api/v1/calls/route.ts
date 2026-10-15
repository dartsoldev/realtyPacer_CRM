import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { listCalls, logCall } from "@/modules/calls/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("calls:log");
  const q = parseQuery(req, z.object({ customerId: z.string().optional(), cleanerId: z.string().optional(), bookingId: z.string().optional() }));
  return ok({ items: await listCalls(user, q) });
});

/** Records a call made from the user's own phone (never inferred from a tel: link click). */
export const POST = route(async (req) => {
  const user = await requireApiUser("calls:log");
  const res = await logCall(user, await readBody(req));
  return ok(res, res.created ? 201 : 200);
});
