import "server-only";
import { Schema } from "mongoose";

export const geoPointSchema = new Schema(
  {
    lat: { type: Number, min: -90, max: 90, required: true },
    lng: { type: Number, min: -180, max: 180, required: true },
  },
  { _id: false },
);

/** Address fields reused by ServiceAddress and the booking-time snapshot. */
export const addressFields = {
  label: { type: String, trim: true, maxlength: 80, default: "" },
  line1: { type: String, required: true, trim: true, maxlength: 200 },
  line2: { type: String, trim: true, maxlength: 200, default: "" },
  city: { type: String, required: true, trim: true, maxlength: 100 },
  /** normalizeCity(city): exact-match filter key. */
  cityNormalized: { type: String, required: true, maxlength: 100 },
  region: { type: String, trim: true, maxlength: 100, default: "" },
  postalCode: { type: String, trim: true, maxlength: 20, default: "" },
  country: { type: String, trim: true, maxlength: 100, default: "Canada" },
  location: { type: geoPointSchema, default: null },
  /** Access / parking instructions. Shown only to office staff and the assigned cleaners. */
  accessInstructions: { type: String, trim: true, maxlength: 2000, default: "" },
} as const;

export const integerValidator = {
  validator: Number.isSafeInteger,
  message: "{PATH} must be an integer",
};
