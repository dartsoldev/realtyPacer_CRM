import { randomUUID } from "node:crypto";
import type { CurrentUser } from "@/lib/auth/current-user";
import { Booking } from "@/lib/db/models/booking";
import { createBooking } from "@/modules/bookings/service";
import { finalizeCharges } from "@/modules/finance/charges";
import { recordPayment } from "@/modules/finance/payments";
import { customerWithAddress } from "./ops-fixtures";

/** Synthetic fixtures only — never production seed data. */
export const key = () => randomUUID().replace(/-/g, "");

export async function customerIn(actor: CurrentUser, city: string, name: string) {
  return customerWithAddress(actor, {
    firstName: name,
    lastName: "Fixture",
    primaryAddress: { label: "Home", line1: `1 ${name} Street`, city, region: "ON", postalCode: "", country: "Canada" },
  });
}

/** A completed (past) booking with explicit unit prices, finalized. Returns booking + line ids by service id. */
export async function finalizedBooking(
  actor: CurrentUser,
  c: { customer: { id: string }; address: { id: string } },
  items: { serviceId: string; unitPriceCents: number; quantity?: number }[],
  opts: { date?: string; time?: string; cleanerIds?: string[]; finalize?: boolean } = {},
) {
  const { booking } = await createBooking(actor, {
    idempotencyKey: key(),
    customerId: c.customer.id,
    addressId: c.address.id,
    date: opts.date ?? "2026-06-10",
    startTime: opts.time ?? "10:00",
    durationMinutes: 60,
    lineItems: items.map((i) => ({ serviceId: i.serviceId, quantity: i.quantity ?? 1, unitPriceCents: i.unitPriceCents })),
    cleanerIds: opts.cleanerIds ?? [],
    status: "COMPLETED",
  });
  if (opts.finalize !== false) await finalizeCharges(actor, booking.id, { expectedVersion: booking.version });
  const doc = (await Booking.findById(booking.id).lean())!;
  const lineFor = (serviceId: string) => String(doc.lineItems.find((l) => String(l.serviceId) === serviceId)!._id);
  return { id: booking.id, doc, lineFor };
}

export async function pay(actor: CurrentUser, customerId: string, amountCents: number, allocations: { bookingId: string; lineItemId: string; amountCents: number }[] = [], date = "2026-06-11") {
  return recordPayment(actor, { idempotencyKey: key(), customerId, amountCents, receivedDate: date, receivedTime: "12:00", method: "e_transfer", allocations });
}
