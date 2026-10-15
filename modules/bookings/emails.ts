import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Booking } from "@/lib/db/models/booking";
import { Customer } from "@/lib/db/models/customer";
import { Organization } from "@/lib/db/models/organization";
import { formatAddress } from "@/lib/domain/links";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { formatDateTime } from "@/lib/domain/time";
import { bookingEmail } from "@/lib/email/templates";
import { getConfigStatus } from "@/lib/env";
import { AppError, Errors } from "@/lib/http/errors";
import { logger } from "@/lib/logger";
import { enforce, RATE_LIMITS } from "@/lib/security/rate-limit";
import { recordAudit } from "@/modules/audit/service";
import { enqueueEmail } from "@/modules/outbox/service";

export const BOOKING_EMAIL_KINDS = ["booking_confirmation", "booking_changed", "booking_cancelled"] as const;
export type BookingEmailKind = (typeof BOOKING_EMAIL_KINDS)[number];

export const sendBookingEmailSchema = z.object({ kind: z.enum(BOOKING_EMAIL_KINDS), idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/) }).strict();

type Setting = "off" | "manual" | "auto";

async function load(orgId: Types.ObjectId | string, bookingId: string) {
  if (!OBJECT_ID_RE.test(bookingId)) throw Errors.notFound("Booking");
  const b = await Booking.findOne({ _id: bookingId, organizationId: orgId }).select("reference customerId scheduledStartAt timezone addressSnapshot lineItems status version").lean();
  if (!b) throw Errors.notFound("Booking");
  const [customer, org] = await Promise.all([
    Customer.findOne({ _id: b.customerId, organizationId: orgId }).select("name firstName email").lean(),
    Organization.findById(orgId).select("displayName contact notifications").lean(),
  ]);
  if (!customer || !org) throw Errors.notFound("Booking");
  return { b, customer, org, setting: ((org.notifications as { customerBookingEmails?: Setting } | undefined)?.customerBookingEmails ?? "off") as Setting };
}

function compose(ctx: Awaited<ReturnType<typeof load>>, kind: BookingEmailKind) {
  const { b, customer, org } = ctx;
  if (!customer.email) return null;
  const contact = (org.contact ?? {}) as { phone?: string; email?: string };
  return bookingEmail({
    to: customer.email,
    customerName: customer.firstName || customer.name,
    orgName: org.displayName,
    orgPhone: contact.phone ?? "",
    orgEmail: contact.email ?? "",
    kind,
    reference: b.reference,
    when: formatDateTime(b.scheduledStartAt, b.timezone),
    address: formatAddress(b.addressSnapshot as never),
    services: b.lineItems.map((l) => `${l.name} × ${l.quantity}`),
  });
}

/** What would be sent, to whom — shown before "Send". */
export async function previewBookingEmail(user: CurrentUser, bookingId: string, kind: BookingEmailKind) {
  if (!user.permissions.has("bookings:notify")) throw Errors.forbidden();
  await connectDb();
  const ctx = await load(user.organizationId, bookingId);
  const msg = compose(ctx, kind);
  const smtp = getConfigStatus("smtp").ok;
  const blocked = ctx.setting === "off" ? "Booking emails are turned off. An administrator can enable them in Organization settings." : !smtp ? "Email isn't configured on the server yet." : !msg ? "This customer has no email address." : null;
  return { to: msg?.to ?? null, subject: msg?.subject ?? null, text: msg?.text ?? null, blocked, setting: ctx.setting };
}

/** Explicit "Send": queues one email per idempotency key (retries never send twice). */
export async function sendBookingEmail(user: CurrentUser, bookingId: string, raw: unknown) {
  if (!user.permissions.has("bookings:notify")) throw Errors.forbidden();
  const input = sendBookingEmailSchema.parse(raw);
  await connectDb();
  await enforce([[RATE_LIMITS.bookingEmailByUser, user.id]]);
  const ctx = await load(user.organizationId, bookingId);
  if (ctx.setting === "off") throw new AppError(409, "BOOKING_EMAILS_OFF", "Booking emails are turned off for this organization.");
  if (!getConfigStatus("smtp").ok) throw new AppError(503, "SETUP_REQUIRED", "Email isn't configured on the server yet.");
  const msg = compose(ctx, input.kind);
  if (!msg) throw new AppError(422, "NO_EMAIL", "This customer has no email address.");
  const res = await enqueueEmail({ organizationId: user.organizationId, kind: input.kind, message: msg, dedupeKey: `booking-email:${input.idempotencyKey}`, relatedType: "booking", relatedId: ctx.b._id, createdBy: user.id });
  if (res.created) await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "booking.email_queued", entityType: "booking", entityId: ctx.b._id, metadata: { kind: input.kind } });
  return { queued: true, id: res.id, created: res.created };
}

/**
 * Automatic emails (setting "auto") after a committed booking change. Never
 * throws into the caller: a failure here must not undo the booking change.
 */
export async function autoBookingEmail(organizationId: Types.ObjectId | string, bookingId: string, kind: BookingEmailKind, changeKey: string) {
  try {
    const ctx = await load(organizationId, bookingId);
    if (ctx.setting !== "auto") return;
    const msg = compose(ctx, kind);
    if (!msg) return;
    await enqueueEmail({ organizationId, kind, message: msg, dedupeKey: `booking-auto:${bookingId}:${kind}:${changeKey}`, relatedType: "booking", relatedId: ctx.b._id });
  } catch (err) {
    logger.error("booking.auto_email_failed", { bookingId, kind, error: err instanceof Error ? err : String(err) });
  }
}
