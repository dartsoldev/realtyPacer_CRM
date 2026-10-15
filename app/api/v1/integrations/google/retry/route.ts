import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { retryCalendarSync } from "@/modules/integrations/google-calendar";

export const runtime = "nodejs";

/** Re-queues failed (or externally changed) booking events; processed by the worker. */
export const POST = route(async (req) => {
  const user = await requireApiUser("integrations:manage");
  return ok(await retryCalendarSync(user, await readBody(req)));
});
