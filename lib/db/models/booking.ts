import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { computeBookingAmounts, NO_TAX } from "@/lib/domain/billing";
import { BILLING_STATES, BOOKING_STATUSES, DISCOUNT_TYPES, MAX_BOOKING_MINUTES, MAX_LINE_ITEMS, MAX_LINE_QUANTITY, MAX_UNIT_PRICE_CENTS } from "@/lib/domain/constants";
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
  /** Gross = quantity × unit price. */
  lineTotalCents: { type: Number, required: true, min: 0, validate: integerValidator },
  /** Booking-level discount allocated to this line (largest-remainder method). */
  discountCents: { type: Number, default: 0, min: 0, validate: integerValidator },
  /** Net service value = gross − discount, before tax. */
  netCents: { type: Number, default: 0, min: 0, validate: integerValidator },
  taxCents: { type: Number, default: 0, min: 0, validate: integerValidator },
  /** Net + tax. Frozen when the booking is FINALIZED. */
  chargedCents: { type: Number, default: 0, min: 0, validate: integerValidator },
  /**
   * Derived balances, maintained in the same transaction as the authoritative
   * ChargeAdjustment / Payment records (see modules/finance). Never edited directly.
   */
  adjustmentCents: { type: Number, default: 0, validate: integerValidator },
  allocatedCents: { type: Number, default: 0, min: 0, validate: integerValidator },
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
    /** Sum of line gross amounts (quantity × unit price). */
    subtotalCents: { type: Number, required: true, min: 0, validate: integerValidator },
    /** Billing state, separate from job status. DRAFT = estimate (no debt); FINALIZED = amount owed. */
    billingState: { type: String, enum: BILLING_STATES, required: true, default: "DRAFT" },
    discount: {
      type: new Schema(
        {
          type: { type: String, enum: DISCOUNT_TYPES, default: "none" },
          amountCents: { type: Number, default: 0, min: 0, validate: integerValidator },
          basisPoints: { type: Number, default: 0, min: 0, max: 10_000, validate: integerValidator },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    /** Tax configuration snapshot (copied from the organization; frozen at finalization). */
    tax: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          rateBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
          label: { type: String, default: "" },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    discountCents: { type: Number, default: 0, min: 0, validate: integerValidator },
    netCents: { type: Number, default: 0, min: 0, validate: integerValidator },
    taxCents: { type: Number, default: 0, min: 0, validate: integerValidator },
    chargedCents: { type: Number, default: 0, min: 0, validate: integerValidator },
    adjustmentsCents: { type: Number, default: 0, validate: integerValidator },
    allocatedCents: { type: Number, default: 0, min: 0, validate: integerValidator },
    finalizedAt: { type: Date, default: null },
    finalizedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    /** Shared contention record for money movements touching this booking's lines. */
    ledgerRevision: { type: Number, default: 0 },
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
  // Draft amounts are always recomputed; finalized amounts are frozen.
  if (this.billingState !== "FINALIZED") {
    const disc = this.discount ?? { type: "none" };
    const tax = this.tax?.enabled ? { enabled: true, rateBasisPoints: this.tax.rateBasisPoints ?? 0, label: this.tax.label ?? "" } : NO_TAX;
    const { lines, totals } = computeBookingAmounts(
      this.lineItems.map((l) => l.lineTotalCents),
      { type: (disc.type ?? "none") as "none" | "fixed" | "percent", amountCents: disc.amountCents ?? 0, basisPoints: disc.basisPoints ?? 0 },
      tax,
    );
    this.lineItems.forEach((l, i) => Object.assign(l, { discountCents: lines[i]!.discountCents, netCents: lines[i]!.netCents, taxCents: lines[i]!.taxCents, chargedCents: lines[i]!.chargedCents }));
    Object.assign(this, { discountCents: totals.discountCents, netCents: totals.netCents, taxCents: totals.taxCents, chargedCents: totals.chargedCents });
  }
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
bookingSchema.index({ organizationId: 1, customerId: 1, billingState: 1 });
bookingSchema.index({ organizationId: 1, status: 1, "lineItems.serviceId": 1, scheduledStartAt: 1 });
// Overlap checks and cleaner schedules.
bookingSchema.index({ organizationId: 1, assignedCleanerIds: 1, status: 1, scheduledStartAt: 1, scheduledEndAt: 1 });

export type BookingDoc = InferSchemaType<typeof bookingSchema> & { _id: Types.ObjectId };

export const Booking = (models.Booking || model("Booking", bookingSchema)) as Model<InferSchemaType<typeof bookingSchema>>;
