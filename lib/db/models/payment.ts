import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { MAX_MONEY_CENTS, PAYMENT_METHODS, PAYMENT_STATUSES } from "@/lib/domain/constants";
import { integerValidator } from "./shared";

/**
 * Part of a receipt applied to one finalized booking service line.
 * `amountCents` is what was applied; `refundedCents` is the part later
 * refunded. Net allocated = amount − refunded. Allocations are append-only.
 */
const allocationSchema = new Schema({
  bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
  lineItemId: { type: Schema.Types.ObjectId, required: true },
  /** Denormalised from the booking line for service-filtered reports. */
  serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
  amountCents: { type: Number, required: true, min: 1, validate: integerValidator },
  refundedCents: { type: Number, default: 0, min: 0, validate: integerValidator },
  allocatedAt: { type: Date, required: true, default: () => new Date() },
  allocatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  /** "receipt" when applied while recording; "credit" when applied later from unallocated credit. */
  source: { type: String, enum: ["receipt", "credit"], default: "receipt" },
  /** Report snapshot taken when the money was applied (avoids a booking lookup per row in cash reports). */
  bookingReference: { type: String, default: null, maxlength: 40 },
  city: { type: String, default: null, maxlength: 100 },
  cityNormalized: { type: String, default: null, maxlength: 100 },
  serviceName: { type: String, default: null, maxlength: 200 },
});

/**
 * A receipt: money actually received (manual record — no card data).
 * Invariant (enforced by the finance service, checked by reconcile):
 *   amount − refunded = netAllocated + unallocated,  all ≥ 0.
 */
const paymentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    /** Human reference, e.g. "PMT-261015-7KQ4M". */
    receiptNumber: { type: String, required: true },
    amountCents: { type: Number, required: true, min: 1, max: MAX_MONEY_CENTS, validate: integerValidator },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
    receivedAt: { type: Date, required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    reference: { type: String, trim: true, maxlength: 120, default: "" },
    note: { type: String, maxlength: 2000, default: "" },
    status: { type: String, enum: PAYMENT_STATUSES, required: true, default: "POSTED" },
    allocations: { type: [allocationSchema], default: [] },
    refundedCents: { type: Number, default: 0, min: 0, validate: integerValidator },
    netAllocatedCents: { type: Number, default: 0, min: 0, validate: integerValidator },
    unallocatedCents: { type: Number, default: 0, min: 0, validate: integerValidator },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reversalReason: { type: String, maxlength: 1000, default: "" },
    idempotencyKey: { type: String, required: true },
    /** Bumped by every change; concurrent writers to the same receipt conflict and retry. */
    revision: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

paymentSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
paymentSchema.index({ organizationId: 1, receiptNumber: 1 }, { unique: true });
paymentSchema.index({ organizationId: 1, receivedAt: -1, _id: -1 });
paymentSchema.index({ organizationId: 1, customerId: 1, receivedAt: -1 });
paymentSchema.index({ organizationId: 1, status: 1, receivedAt: -1 });
paymentSchema.index({ organizationId: 1, "allocations.bookingId": 1 });
paymentSchema.index({ organizationId: 1, "allocations.serviceId": 1 });
paymentSchema.index({ organizationId: 1, customerId: 1, unallocatedCents: 1 });

export type PaymentDoc = InferSchemaType<typeof paymentSchema> & { _id: Types.ObjectId };

export const Payment = (models.Payment || model("Payment", paymentSchema)) as Model<InferSchemaType<typeof paymentSchema>>;
