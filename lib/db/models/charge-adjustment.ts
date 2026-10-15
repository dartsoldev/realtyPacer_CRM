import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { MAX_MONEY_CENTS } from "@/lib/domain/constants";
import { integerValidator } from "./shared";

/**
 * Append-only correction to a FINALIZED booking line. Negative = credit
 * (reduces what is owed, e.g. cancellation or goodwill); positive = extra
 * charge. Finalized lines themselves are never rewritten.
 */
const chargeAdjustmentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    lineItemId: { type: Schema.Types.ObjectId, required: true },
    serviceId: { type: Schema.Types.ObjectId, ref: "Service", required: true },
    amountCents: {
      type: Number,
      required: true,
      min: -MAX_MONEY_CENTS,
      max: MAX_MONEY_CENTS,
      validate: [integerValidator, { validator: (v: number) => v !== 0, message: "Adjustment cannot be zero" }],
    },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    kind: { type: String, enum: ["credit", "charge", "cancellation_credit"], required: true },
    idempotencyKey: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

chargeAdjustmentSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
chargeAdjustmentSchema.index({ organizationId: 1, bookingId: 1, createdAt: 1 });
chargeAdjustmentSchema.index({ organizationId: 1, customerId: 1, createdAt: -1 });

export type ChargeAdjustmentDoc = InferSchemaType<typeof chargeAdjustmentSchema> & { _id: Types.ObjectId };

export const ChargeAdjustment = (models.ChargeAdjustment || model("ChargeAdjustment", chargeAdjustmentSchema)) as Model<
  InferSchemaType<typeof chargeAdjustmentSchema>
>;
