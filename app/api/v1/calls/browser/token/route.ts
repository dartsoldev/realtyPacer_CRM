import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { refreshVoiceToken } from "@/modules/calls/service";

export const runtime = "nodejs";

export const POST = route(async () => {
  const user = await requireApiUser("calls:browser");
  return ok(refreshVoiceToken(user));
});
