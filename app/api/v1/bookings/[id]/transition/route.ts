import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { transitionBooking } from "@/modules/bookings/service";

export const runtime = "nodejs";

export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  return ok(await transitionBooking(user, (await params).id, await readBody(req)));
});
