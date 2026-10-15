import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { PAYMENT_METHODS, PAYMENT_STATUSES } from "@/lib/domain/constants";
import { validatePaymentAllocations } from "@/lib/domain/allocations";
import { integerValidator } from "./shared";

const allocationSchema = new Schema(
  {
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    lineItemId: { type: Schema.Types.ObjectId, required: true },
    /** Denormalised from the booking line item for service-filtered reports. */
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    amountCents: { type: Number, required: true, min: 1, validate: integerValidator },
  },
  { _id: false },
);

const paymentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    amountCents: { type: Number, required: true, min: 1, validate: integerValidator },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
    paidAt: { type: Date, required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    status: { type: String, enum: PAYMENT_STATUSES, required: true, default: "completed" },
    reference: { type: String, trim: true, maxlength: 120, default: "" },
    notes: { type: String, maxlength: 2000, default: "" },
    allocations: { type: [allocationSchema], default: [] },
  },
  { timestamps: true },
);

// Per-payment rules. Cross-payment line-item capacity is enforced in the
// payments service (phase 3) with findLineItemOverAllocations.
paymentSchema.pre("validate", function () {
  const issues = validatePaymentAllocations(
    this.amountCents,
    this.allocations.map((a) => ({
      bookingId: String(a.bookingId),
      lineItemId: String(a.lineItemId),
      amountCents: a.amountCents,
    })),
  );
  if (issues.length > 0) this.invalidate("allocations", `Invalid allocations: ${issues.map((i) => i.code).join(", ")}`);
});

paymentSchema.index({ organizationId: 1, paidAt: -1 });
paymentSchema.index({ organizationId: 1, customerId: 1, paidAt: -1 });
paymentSchema.index({ organizationId: 1, status: 1, paidAt: -1 });
paymentSchema.index({ organizationId: 1, "allocations.bookingId": 1 });
paymentSchema.index({ organizationId: 1, "allocations.serviceId": 1, paidAt: -1 });

export type PaymentDoc = InferSchemaType<typeof paymentSchema> & { _id: Types.ObjectId };

export const Payment: Model<InferSchemaType<typeof paymentSchema>> = models.Payment || model("Payment", paymentSchema);
