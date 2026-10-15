import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { BOOKING_EMAIL_KINDS, previewBookingEmail, sendBookingEmail } from "@/modules/bookings/emails";
import { bookingEmails } from "@/modules/outbox/service";

export const runtime = "nodejs";

/** ?kind=… → preview (recipient, subject, text) plus this booking's email history. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("bookings:notify");
  const { id } = await params;
  const { kind } = parseQuery(req, z.object({ kind: z.enum(BOOKING_EMAIL_KINDS).default("booking_confirmation") }));
  const [preview, history] = await Promise.all([previewBookingEmail(user, id, kind), bookingEmails(user, id)]);
  return ok({ preview, history });
});

/** Queues the email for delivery by the worker (idempotent per key). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("bookings:notify");
  const res = await sendBookingEmail(user, (await params).id, await readBody(req));
  return ok(res, res.created ? 202 : 200);
});
