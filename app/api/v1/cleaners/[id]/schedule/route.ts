import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { cleanerSchedule } from "@/modules/bookings/service";
import { getCleaner } from "@/modules/cleaners/service";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("cleaners:read");
  const cleaner = await getCleaner(user, (await params).id);
  return ok(await cleanerSchedule(user, cleaner.id));
});
