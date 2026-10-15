/**
 * Booking validation and lifecycle rules shared by API and client.
 * No server-only imports.
 */
import { z } from "zod";
import { BOOKING_STATUSES, MAX_BOOKING_MINUTES, MAX_LINE_ITEMS, MAX_LINE_QUANTITY, MAX_UNIT_PRICE_CENTS, type BookingStatus } from "@/lib/domain/constants";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { isDateKey } from "@/lib/domain/zoned-time";

const objectId = z.string().regex(OBJECT_ID_RE, "Invalid id");
const dateKey = z.string().refine(isDateKey, "Choose a valid date");
const timeKey = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a valid time");

export const lineItemInputSchema = z
  .object({
    /** Present for items that already exist on the booking (keeps their stable id). */
    lineItemId: objectId.optional(),
    serviceId: objectId,
    quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(MAX_LINE_QUANTITY),
    /** Only with price-override permission; omitted = catalog price (new) or existing price (kept). */
    unitPriceCents: z.number().int("Use whole cents").min(0).max(MAX_UNIT_PRICE_CENTS).optional(),
  })
  .strict();

const scheduleFields = {
  date: dateKey,
  startTime: timeKey,
  durationMinutes: z.number().int().min(15, "Minimum 15 minutes").max(MAX_BOOKING_MINUTES, "Maximum 24 hours"),
  /** Needed only when the local time occurs twice (end of daylight saving time). */
  disambiguation: z.enum(["earlier", "later"]).optional(),
};

export const createBookingSchema = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/, "Invalid request key"),
    customerId: objectId,
    addressId: objectId,
    ...scheduleFields,
    lineItems: z.array(lineItemInputSchema).min(1, "Add at least one service").max(MAX_LINE_ITEMS),
    cleanerIds: z.array(objectId).max(10).default([]),
    instructions: z.string().trim().max(5000).default(""),
    officeNotes: z.string().trim().max(5000).default(""),
    /** COMPLETED is for recording past jobs; it requires a start time in the past. */
    status: z.enum(["SCHEDULED", "COMPLETED"]).default("SCHEDULED"),
    /** Values for booking custom fields (validated against the organization's definitions). */
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const updateBookingSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    date: scheduleFields.date.optional(),
    startTime: scheduleFields.startTime.optional(),
    durationMinutes: scheduleFields.durationMinutes.optional(),
    disambiguation: scheduleFields.disambiguation,
    lineItems: z.array(lineItemInputSchema).min(1).max(MAX_LINE_ITEMS).optional(),
    cleanerIds: z.array(objectId).max(10).optional(),
    instructions: z.string().trim().max(5000).optional(),
    officeNotes: z.string().trim().max(5000).optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => [v.date, v.startTime, v.durationMinutes].every((x) => x === undefined) || [v.date, v.startTime, v.durationMinutes].every((x) => x !== undefined), {
    message: "Date, start time and duration must be sent together",
    path: ["date"],
  });

export const BOOKING_ACTIONS = ["start", "complete", "cancel", "reopen"] as const;
export type BookingAction = (typeof BOOKING_ACTIONS)[number];

export const transitionSchema = z
  .object({
    action: z.enum(BOOKING_ACTIONS),
    expectedVersion: z.number().int().min(0),
    reason: z.string().trim().max(1000).default(""),
  })
  .strict()
  .refine((v) => !["cancel", "reopen"].includes(v.action) || v.reason.length >= 3, { message: "Give a reason", path: ["reason"] });

export const changeAddressSchema = z.object({ addressId: objectId, expectedVersion: z.number().int().min(0) }).strict();

/** Allowed status transitions (enforced server-side). */
export const TRANSITIONS: Record<BookingAction, { from: BookingStatus[]; to: BookingStatus }> = {
  start: { from: ["SCHEDULED"], to: "IN_PROGRESS" },
  complete: { from: ["SCHEDULED", "IN_PROGRESS"], to: "COMPLETED" },
  cancel: { from: ["SCHEDULED", "IN_PROGRESS"], to: "CANCELLED" },
  reopen: { from: ["COMPLETED"], to: "IN_PROGRESS" },
};

/** Which fields may change in each status. */
export const EDITABLE_FIELDS: Record<BookingStatus, Array<"schedule" | "lineItems" | "cleaners" | "instructions" | "officeNotes" | "address">> = {
  SCHEDULED: ["schedule", "lineItems", "cleaners", "instructions", "officeNotes", "address"],
  IN_PROGRESS: ["cleaners", "instructions", "officeNotes"],
  COMPLETED: ["officeNotes"],
  CANCELLED: ["officeNotes"],
};

export const bookingListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(BOOKING_STATUSES).optional(),
  from: dateKey.optional(),
  to: dateKey.optional(),
  cleanerId: objectId.optional(),
  customerId: objectId.optional(),
  city: z.string().trim().max(100).optional(),
  unassigned: z.enum(["1"]).optional(),
  q: z.string().trim().max(40).optional(),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

export const MAX_CALENDAR_DAYS = 62;

export const calendarQuery = z.object({
  start: dateKey,
  end: dateKey,
  cleanerId: objectId.optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  city: z.string().trim().max(100).optional(),
});

export const operationsQuery = z.object({ from: dateKey.optional(), to: dateKey.optional() });
