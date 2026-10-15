import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, route } from "@/lib/http/api";
import { isDateKey, localDaysRange } from "@/lib/domain/zoned-time";
import { googleBusy } from "@/modules/integrations/google-calendar";

export const runtime = "nodejs";

/** Busy periods (start/end only) in the connected Google calendar for one local date, for a conflict warning. */
export const GET = route(async (req) => {
  const user = await requireApiUser("bookings:write");
  const { date } = parseQuery(req, z.object({ date: z.string().refine(isDateKey, "Invalid date") }));
  const { start, end } = localDaysRange(date, date, user.organization.timezone);
  return ok(await googleBusy(user, start, end));
});
