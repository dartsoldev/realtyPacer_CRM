import "server-only";
import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { DEFAULT_CURRENCY, DEFAULT_TIMEZONE } from "@/lib/domain/constants";
import { isValidTimeZone } from "@/lib/domain/time";

const contactSchema = new Schema(
  {
    email: { type: String, trim: true, lowercase: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 40 },
    website: { type: String, trim: true, maxlength: 200 },
    addressLine1: { type: String, trim: true, maxlength: 200 },
    city: { type: String, trim: true, maxlength: 100 },
    region: { type: String, trim: true, maxlength: 100 },
    postalCode: { type: String, trim: true, maxlength: 20 },
    country: { type: String, trim: true, maxlength: 100 },
    serviceArea: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false },
);

const brandingSchema = new Schema(
  {
    primaryColor: { type: String, default: "#DC2626", match: /^#[0-9a-fA-F]{6}$/ },
  },
  { _id: false },
);

/** Configurable labels so the CRM can serve other service businesses later. */
const terminologySchema = new Schema(
  {
    customer: { type: String, default: "Customer", trim: true, maxlength: 40 },
    booking: { type: String, default: "Booking", trim: true, maxlength: 40 },
    provider: { type: String, default: "Cleaner", trim: true, maxlength: 40 },
  },
  { _id: false },
);

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    timezone: {
      type: String,
      required: true,
      default: DEFAULT_TIMEZONE,
      validate: { validator: isValidTimeZone, message: "Invalid IANA timezone" },
    },
    currency: { type: String, required: true, default: DEFAULT_CURRENCY, match: /^[A-Z]{3}$/ },
    contact: { type: contactSchema, default: () => ({}) },
    branding: { type: brandingSchema, default: () => ({}) },
    terminology: { type: terminologySchema, default: () => ({}) },
    /**
     * Sales tax: disabled until an administrator configures it explicitly.
     * RealtyPacer makes no jurisdictional tax decisions; the configured rate is
     * snapshotted onto each booking when its charges are finalized.
     */
    tax: {
      type: new Schema(
        {
          enabled: { type: Boolean, default: false },
          rateBasisPoints: { type: Number, default: 0, min: 0, max: 10_000 },
          label: { type: String, trim: true, maxlength: 40, default: "" },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    scheduling: {
      type: new Schema(
        {
          /** Minimum gap between one cleaner's jobs. 0 = back-to-back jobs allowed. */
          bufferMinutes: { type: Number, default: 0, min: 0, max: 240 },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
  },
  { timestamps: true },
);

export type OrganizationDoc = InferSchemaType<typeof organizationSchema> & { _id: import("mongoose").Types.ObjectId };

export const Organization: Model<InferSchemaType<typeof organizationSchema>> =
  models.Organization || model("Organization", organizationSchema);
