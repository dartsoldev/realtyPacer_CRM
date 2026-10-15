import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { selectGoogleCalendar } from "@/modules/integrations/google-calendar";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  const user = await requireApiUser("integrations:manage");
  return ok(await selectGoogleCalendar(user, await readBody(req)));
});
