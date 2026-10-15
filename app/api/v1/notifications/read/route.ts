import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { markRead } from "@/modules/notifications/service";

export const runtime = "nodejs";

/** { all: true } or { ids: [...] } — only the caller's notifications are affected. */
export const POST = route(async (req) => {
  const user = await requireApiUser();
  return ok(await markRead(user, await readBody(req)));
});
