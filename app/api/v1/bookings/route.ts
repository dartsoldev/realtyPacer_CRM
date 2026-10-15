import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { bookingListQuery } from "@/modules/bookings/schemas";
import { createBooking, listBookings } from "@/modules/bookings/service";

export const runtime = "nodejs";

/** Office users see all bookings; cleaners only their own assignments. */
export const GET = route(async (req) => {
  const user = await requireApiUser();
  return ok(await listBookings(user, parseQuery(req, bookingListQuery)));
});

/** Idempotent on body.idempotencyKey: retries return the original booking with 200. */
export const POST = route(async (req) => {
  const user = await requireApiUser("bookings:write");
  const { booking, created } = await createBooking(user, await readBody(req));
  return ok(booking, created ? 201 : 200);
});
