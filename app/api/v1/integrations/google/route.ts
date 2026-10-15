import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { googleStatus } from "@/modules/integrations/google-calendar";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("integrations:manage");
  return ok(await googleStatus(user));
});
