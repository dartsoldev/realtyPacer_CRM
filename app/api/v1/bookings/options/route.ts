import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { activeServicesForBooking } from "@/modules/catalog/service";
import { assignableCleaners } from "@/modules/cleaners/service";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("bookings:write");
  const [services, cleaners] = await Promise.all([activeServicesForBooking(user), assignableCleaners(user)]);
  return ok({ services, cleaners, timezone: user.organization.timezone, currency: user.organization.currency });
});
