import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { listGoogleCalendars } from "@/modules/integrations/google-calendar";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("integrations:manage");
  return ok({ items: await listGoogleCalendars(user) });
});
