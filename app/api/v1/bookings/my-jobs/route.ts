import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { myJobs } from "@/modules/bookings/service";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("bookings:read_assigned");
  return ok(await myJobs(user));
});
