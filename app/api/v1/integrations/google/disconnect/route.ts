import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { disconnectGoogle } from "@/modules/integrations/google-calendar";

export const runtime = "nodejs";

export const POST = route(async () => {
  const user = await requireApiUser("integrations:manage");
  return ok(await disconnectGoogle(user));
});
