import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { CONTACT_SOURCES, CUSTOMER_TYPES } from "@/lib/domain/constants";

/**
 * Customer profile only. Bookings, payments, activities and loyalty entries
 * live in their own collections; counts, service days and spending are derived.
 * Customers are never login accounts.
 */
const customerSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    /** Display name: "First Last" for individuals, or a business/display name. */
    name: { type: String, required: true, trim: true, maxlength: 160 },
    /** Lower-cased name used for case-insensitive search and duplicate checks. */
    searchName: { type: String, required: true, maxlength: 160 },
    firstName: { type: String, trim: true, maxlength: 80, default: "" },
    lastName: { type: String, trim: true, maxlength: 80, default: "" },
    companyName: { type: String, trim: true, maxlength: 160, default: "" },
    customerType: { type: String, enum: CUSTOMER_TYPES, required: true, default: "individual" },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
    /** E.164 phone, e.g. "+15145550123". Shared numbers are allowed (households, businesses). */
    phone: { type: String, trim: true, maxlength: 20, default: null },
    /** Digits of `phone`, for partial-number search. */
    phoneDigits: { type: String, maxlength: 20, default: null },
    /** Human formatting captured at entry, e.g. "(514) 555-0123". */
    phoneDisplay: { type: String, trim: true, maxlength: 40, default: null },
    phoneCountry: { type: String, maxlength: 2, default: null },
    relationshipStartedAt: { type: Date, default: null },
    contactSource: { type: String, enum: [...CONTACT_SOURCES, null], default: null },
    tags: { type: [String], default: [] },
    notes: { type: String, maxlength: 5000, default: "" },
    /** Denormalised from active service addresses for list filtering (see address service). */
    addressCities: { type: [String], default: [] },
    primaryCity: { type: String, default: null },
    /** Values for admin-defined CustomFieldDefinition keys; validated in phase 3. */
    customFields: { type: Schema.Types.Mixed, default: () => ({}) },
    /**
     * Derived balances, updated in the same transaction as the authoritative
     * financial records (receipts, refunds, allocations, finalization,
     * adjustments, loyalty entries). Never editable; see modules/finance/reconcile.
     */
    outstandingCents: { type: Number, default: 0, min: 0 },
    creditCents: { type: Number, default: 0, min: 0 },
    pointsBalance: { type: Number, default: 0, min: 0 },
    lastPaymentAt: { type: Date, default: null },
    /** Shared contention record for this customer's money and points movements. */
    ledgerRevision: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, minimize: false },
);

customerSchema.index({ organizationId: 1, archivedAt: 1, searchName: 1, _id: 1 });
customerSchema.index({ organizationId: 1, archivedAt: 1, createdAt: -1, _id: -1 });
customerSchema.index({ organizationId: 1, email: 1 });
customerSchema.index({ organizationId: 1, phone: 1 });
customerSchema.index({ organizationId: 1, phoneDigits: 1 });
customerSchema.index({ organizationId: 1, tags: 1 });
customerSchema.index({ organizationId: 1, addressCities: 1 });
customerSchema.index({ organizationId: 1, outstandingCents: -1 });
customerSchema.index({ organizationId: 1, pointsBalance: -1 });

export type CustomerDoc = InferSchemaType<typeof customerSchema> & { _id: Types.ObjectId };

export const Customer = (models.Customer || model("Customer", customerSchema)) as Model<InferSchemaType<typeof customerSchema>>;
