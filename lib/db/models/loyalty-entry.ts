import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { integerValidator } from "./shared";

/** Append-only points ledger; a customer's balance is the sum of entries. */
const loyaltyEntrySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    pointsChange: {
      type: Number,
      required: true,
      validate: [integerValidator, { validator: (v: number) => v !== 0, message: "pointsChange cannot be 0" }],
    },
    reason: { type: String, required: true, trim: true, maxlength: 200 },
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
    occurredAt: { type: Date, required: true, default: () => new Date() },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

loyaltyEntrySchema.index({ organizationId: 1, customerId: 1, occurredAt: -1 });

export type LoyaltyEntryDoc = InferSchemaType<typeof loyaltyEntrySchema> & { _id: Types.ObjectId };

export const LoyaltyEntry: Model<InferSchemaType<typeof loyaltyEntrySchema>> =
  models.LoyaltyEntry || model("LoyaltyEntry", loyaltyEntrySchema);
