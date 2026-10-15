import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { LOYALTY_ENTRY_TYPES, MAX_POINTS_CHANGE } from "@/lib/domain/constants";
import { integerValidator } from "./shared";

/**
 * Append-only points ledger. Customer.pointsBalance is updated in the same
 * transaction and must always equal the sum of entries (reconcile check).
 * No automatic earning, expiry or monetary value in this phase.
 */
const loyaltyEntrySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    type: { type: String, enum: LOYALTY_ENTRY_TYPES, required: true },
    pointsChange: {
      type: Number,
      required: true,
      min: -MAX_POINTS_CHANGE,
      max: MAX_POINTS_CHANGE,
      validate: [integerValidator, { validator: (v: number) => v !== 0, message: "pointsChange cannot be 0" }],
    },
    /** Balance immediately after this entry (for readable history). */
    balanceAfter: { type: Number, required: true, min: 0, validate: integerValidator },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    reference: {
      type: new Schema(
        {
          type: { type: String, enum: ["booking", "payment", "manual"], required: true },
          id: { type: Schema.Types.ObjectId, default: null },
        },
        { _id: false },
      ),
      default: () => ({ type: "manual" }),
    },
    /** For type "reversal": the entry being reversed (each entry can be reversed once). */
    reversesEntryId: { type: Schema.Types.ObjectId, default: null },
    idempotencyKey: { type: String, required: true },
    occurredAt: { type: Date, required: true, default: () => new Date() },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

loyaltyEntrySchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
loyaltyEntrySchema.index({ organizationId: 1, customerId: 1, occurredAt: -1, _id: -1 });
loyaltyEntrySchema.index({ organizationId: 1, reversesEntryId: 1 }, { unique: true, partialFilterExpression: { reversesEntryId: { $type: "objectId" } } });

export type LoyaltyEntryDoc = InferSchemaType<typeof loyaltyEntrySchema> & { _id: Types.ObjectId };

export const LoyaltyEntry = (models.LoyaltyEntry || model("LoyaltyEntry", loyaltyEntrySchema)) as Model<InferSchemaType<typeof loyaltyEntrySchema>>;
