import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { startBrowserCall } from "@/modules/calls/service";

export const runtime = "nodejs";

/** { targetType, targetId, bookingId? } → { callLogId, token }. The number is resolved on the server. */
export const POST = route(async (req) => {
  const user = await requireApiUser("calls:browser");
  return ok(await startBrowserCall(user, await readBody(req)), 201);
});
