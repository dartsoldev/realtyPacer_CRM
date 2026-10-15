import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { startGoogleConnect } from "@/modules/integrations/google-calendar";

export const runtime = "nodejs";

/** Returns Google's consent URL (state + PKCE stored server-side). */
export const POST = route(async () => {
  const user = await requireApiUser("integrations:manage");
  return ok(await startGoogleConnect(user));
});
