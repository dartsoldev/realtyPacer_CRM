import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, route } from "@/lib/http/api";
import { calendarQuery } from "@/modules/bookings/schemas";
import { calendarEvents } from "@/modules/bookings/service";

export const runtime = "nodejs";

/** start/end are local dates (org timezone), inclusive, at most 62 days. */
export const GET = route(async (req) => {
  const user = await requireApiUser();
  return ok(await calendarEvents(user, parseQuery(req, calendarQuery)));
});
