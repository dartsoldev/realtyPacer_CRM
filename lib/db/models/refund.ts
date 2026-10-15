import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { MAX_MONEY_CENTS } from "@/lib/domain/constants";
import { integerValidator } from "./shared";

/**
 * A refund recorded after it was processed outside RealtyPacer (nothing is
 * sent automatically). Linked to one receipt; each portion names the
 * allocation it reduces, or `allocationId: null` for unallocated credit.
 */
const portionSchema = new Schema(
  {
    allocationId: { type: Schema.Types.ObjectId, default: null },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    lineItemId: { type: Schema.Types.ObjectId, default: null },
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", default: null },
    amountCents: { type: Number, required: true, min: 1, validate: integerValidator },
    /** Report snapshot taken when the money was applied (avoids a booking lookup per row in cash reports). */
    bookingReference: { type: String, default: null, maxlength: 40 },
    city: { type: String, default: null, maxlength: 100 },
    cityNormalized: { type: String, default: null, maxlength: 100 },
    serviceName: { type: String, default: null, maxlength: 200 },
  },
  { _id: false },
);

const refundSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    paymentId: { type: Schema.Types.ObjectId, ref: "Payment", required: true },
    amountCents: { type: Number, required: true, min: 1, max: MAX_MONEY_CENTS, validate: integerValidator },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
    refundedAt: { type: Date, required: true },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    reference: { type: String, trim: true, maxlength: 120, default: "" },
    portions: { type: [portionSchema], default: [] },
    idempotencyKey: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

refundSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
refundSchema.index({ organizationId: 1, refundedAt: -1, _id: -1 });
refundSchema.index({ organizationId: 1, paymentId: 1 });
refundSchema.index({ organizationId: 1, customerId: 1, refundedAt: -1 });

export type RefundDoc = InferSchemaType<typeof refundSchema> & { _id: Types.ObjectId };

export const Refund = (models.Refund || model("Refund", refundSchema)) as Model<InferSchemaType<typeof refundSchema>>;
