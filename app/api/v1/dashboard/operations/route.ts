import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, route } from "@/lib/http/api";
import { operationsQuery } from "@/modules/bookings/schemas";
import { operationsSummary } from "@/modules/bookings/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("bookings:read");
  return ok(await operationsSummary(user, parseQuery(req, operationsQuery)));
});
