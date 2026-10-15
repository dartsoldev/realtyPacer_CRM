import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { MAX_BOOKING_MINUTES, MAX_UNIT_PRICE_CENTS } from "@/lib/domain/constants";
import { integerValidator } from "./shared";

/**
 * Catalog entry. Bookings snapshot name/price/unit/duration into their line
 * items, so editing the catalog never changes historical bookings.
 */
const serviceSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    searchName: { type: String, required: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 2000, default: "" },
    category: { type: String, trim: true, maxlength: 60, default: "" },
    defaultPriceCents: { type: Number, required: true, min: 0, max: MAX_UNIT_PRICE_CENTS, validate: integerValidator },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
    durationMinutes: { type: Number, required: true, min: 0, max: MAX_BOOKING_MINUTES, validate: integerValidator },
    /** e.g. "item", "room", "visit", "hour". */
    unitLabel: { type: String, trim: true, maxlength: 30, default: "item" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

serviceSchema.index({ organizationId: 1, active: 1, searchName: 1, _id: 1 });

export type ServiceDoc = InferSchemaType<typeof serviceSchema> & { _id: Types.ObjectId };

export const Service = (models.Service || model("Service", serviceSchema)) as Model<InferSchemaType<typeof serviceSchema>>;
