import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { getBooking, updateBooking } from "@/modules/bookings/service";

export const runtime = "nodejs";

/** Response is shaped per viewer: no prices without pricing:read, no office notes for cleaners. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await getBooking(user, (await params).id));
});

/** Requires expectedVersion; 409 STALE_VERSION when someone else saved first. */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("bookings:write");
  return ok(await updateBooking(user, (await params).id, await readBody(req)));
});
