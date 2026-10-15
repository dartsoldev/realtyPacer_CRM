import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { BOOKING_STATUSES, MAX_BOOKING_MINUTES, MAX_LINE_ITEMS, MAX_LINE_QUANTITY, MAX_UNIT_PRICE_CENTS } from "@/lib/domain/constants";
import { addressFields, integerValidator } from "./shared";

/**
 * Service line item. `_id` is stable for the life of the booking so phase-3
 * payments can allocate to it. Name, unit, price and duration are snapshots.
 */
const lineItemSchema = new Schema({
  serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  unitLabel: { type: String, trim: true, maxlength: 30, default: "item" },
  quantity: { type: Number, required: true, min: 1, max: MAX_LINE_QUANTITY, validate: integerValidator },
  unitPriceCents: { type: Number, required: true, min: 0, max: MAX_UNIT_PRICE_CENTS, validate: integerValidator },
  /** Catalog price at the time the item was added (for override auditing). */
  catalogUnitPriceCents: { type: Number, required: true, min: 0, validate: integerValidator },
  durationMinutes: { type: Number, required: true, min: 0, max: MAX_BOOKING_MINUTES, validate: integerValidator },
  lineTotalCents: { type: Number, required: true, min: 0, validate: integerValidator },
});

const addressSnapshotSchema = new Schema(addressFields, { _id: false });

const bookingSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    /** Human reference, e.g. "RP-261015-7KQ4". Random, never derived from a count. */
    reference: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    serviceAddressId: { type: Schema.Types.ObjectId, ref: "ServiceAddress", default: null },
    assignedCleanerIds: { type: [{ type: Schema.Types.ObjectId, ref: "Cleaner" }], default: [] },
    scheduledStartAt: { type: Date, required: true },
    scheduledEndAt: { type: Date, required: true },
    /** Organization timezone used when the booking was entered (display/reporting reference). */
    timezone: { type: String, required: true },
    status: { type: String, enum: BOOKING_STATUSES, required: true, default: "SCHEDULED" },
    /** Visible to the assigned cleaners. */
    instructions: { type: String, maxlength: 5000, default: "" },
    /** Office-only notes; never sent to cleaners. */
    officeNotes: { type: String, maxlength: 5000, default: "" },
    /** Address as it was when booked/last explicitly changed. */
    addressSnapshot: { type: addressSnapshotSchema, required: true },
    lineItems: {
      type: [lineItemSchema],
      validate: { validator: (v: unknown[]) => v.length > 0 && v.length <= MAX_LINE_ITEMS, message: `1–${MAX_LINE_ITEMS} service items required` },
    },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
    /** Sum of line totals (service subtotal — no taxes or discounts in this phase). */
    subtotalCents: { type: Number, required: true, min: 0, validate: integerValidator },
    actualStartedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, maxlength: 1000, default: "" },
    /** Optimistic concurrency: every write increments it; writers must send the version they read. */
    version: { type: Number, required: true, default: 0 },
    /** Client-supplied key making creation idempotent across retries / double clicks. */
    idempotencyKey: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    customFields: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true, minimize: false },
);

bookingSchema.pre("validate", function () {
  for (const item of this.lineItems) item.lineTotalCents = item.quantity * item.unitPriceCents;
  this.subtotalCents = this.lineItems.reduce((sum, i) => sum + i.lineTotalCents, 0);
  if (this.scheduledStartAt && this.scheduledEndAt && this.scheduledEndAt <= this.scheduledStartAt) {
    this.invalidate("scheduledEndAt", "Scheduled end must be after scheduled start");
  }
});

bookingSchema.index({ organizationId: 1, reference: 1 }, { unique: true });
bookingSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);
bookingSchema.index({ organizationId: 1, scheduledStartAt: 1, _id: 1 });
bookingSchema.index({ organizationId: 1, status: 1, scheduledStartAt: 1 });
bookingSchema.index({ organizationId: 1, customerId: 1, scheduledStartAt: -1 });
bookingSchema.index({ organizationId: 1, "addressSnapshot.cityNormalized": 1, scheduledStartAt: 1 });
bookingSchema.index({ organizationId: 1, "lineItems.serviceId": 1, scheduledStartAt: 1 });
// Overlap checks and cleaner schedules.
bookingSchema.index({ organizationId: 1, assignedCleanerIds: 1, status: 1, scheduledStartAt: 1, scheduledEndAt: 1 });

export type BookingDoc = InferSchemaType<typeof bookingSchema> & { _id: Types.ObjectId };

export const Booking = (models.Booking || model("Booking", bookingSchema)) as Model<InferSchemaType<typeof bookingSchema>>;
