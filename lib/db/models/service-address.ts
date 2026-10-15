import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { addressFields } from "./shared";

const linkSchema = new Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 80 },
    /** http(s) only; validated in the address service. */
    url: { type: String, required: true, trim: true, maxlength: 2000 },
  },
  { _id: false },
);

/**
 * A customer's current service address. Bookings keep their own snapshot, so
 * editing or archiving an address never rewrites history.
 */
const serviceAddressSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    ...addressFields,
    /** Default address for new bookings (one per customer, maintained by the service). */
    isPrimary: { type: Boolean, default: false },
    links: { type: [linkSchema], default: [] },
    customFields: { type: Schema.Types.Mixed, default: () => ({}) },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

serviceAddressSchema.index({ organizationId: 1, customerId: 1, archivedAt: 1 });
serviceAddressSchema.index({ organizationId: 1, cityNormalized: 1 });

export type ServiceAddressDoc = InferSchemaType<typeof serviceAddressSchema> & { _id: Types.ObjectId };

export const ServiceAddress = (models.ServiceAddress || model("ServiceAddress", serviceAddressSchema)) as Model<
  InferSchemaType<typeof serviceAddressSchema>
>;
