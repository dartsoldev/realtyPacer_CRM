import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";

import { LEAD_CATEGORIES, LEAD_CHANNELS, LEAD_STATUSES, RE_INTENTS } from "@/lib/domain/leads";

export { LEAD_CATEGORIES, LEAD_CHANNELS, LEAD_STATUSES, RE_INTENTS };
export type { LeadCategory, LeadStatus } from "@/lib/domain/leads";

const historySchema = new Schema(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    kind: { type: String, enum: ["created", "note", "status", "assigned", "converted", "updated"], required: true },
    text: { type: String, maxlength: 2000, default: "" },
  },
  { _id: false },
);

/**
 * A potential customer. Category (general/service vs real estate) is
 * independent of source (where it came from). Nothing here is a deal,
 * listing or property record.
 */
const leadSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    category: { type: String, enum: LEAD_CATEGORIES, required: true },
    channel: { type: String, enum: LEAD_CHANNELS, required: true },
    /** Human-readable source, e.g. "Website cleaning form", "Referral", "Phone call". */
    source: { type: String, maxlength: 120, default: "" },
    sourceId: { type: Schema.Types.ObjectId, ref: "LeadSource", default: null },
    /** Submission id from the sending system (or a payload hash) — prevents duplicates on retries. */
    externalId: { type: String, maxlength: 200, default: null },
    name: { type: String, required: true, maxlength: 160 },
    searchName: { type: String, maxlength: 160 },
    phone: { type: String, default: null, maxlength: 20 },
    phoneDisplay: { type: String, default: null, maxlength: 40 },
    email: { type: String, default: null, maxlength: 254 },
    city: { type: String, default: "", maxlength: 100 },
    address: { type: String, default: "", maxlength: 300 },
    receivedAt: { type: Date, required: true },
    status: { type: String, enum: LEAD_STATUSES, default: "new" },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", default: null },
    notes: { type: String, default: "", maxlength: 5000 },
    service: {
      type: new Schema({ requestedService: { type: String, maxlength: 200, default: "" }, preferredDate: { type: String, default: null }, serviceLocation: { type: String, maxlength: 300, default: "" } }, { _id: false }),
      default: null,
    },
    realEstate: {
      type: new Schema(
        {
          intent: { type: String, enum: [...RE_INTENTS, null], default: null },
          areaOfInterest: { type: String, maxlength: 200, default: "" },
          budgetCents: { type: Number, default: null, min: 0 },
          listingUrl: { type: String, maxlength: 2000, default: "" },
        },
        { _id: false },
      ),
      default: null,
    },
    convertedCustomerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    convertedAt: { type: Date, default: null },
    convertedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    history: { type: [historySchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);
leadSchema.index({ organizationId: 1, category: 1, status: 1, receivedAt: -1 });
leadSchema.index({ organizationId: 1, sourceId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } });
leadSchema.index({ organizationId: 1, phone: 1 });
leadSchema.index({ organizationId: 1, email: 1 });

export type LeadDoc = InferSchemaType<typeof leadSchema> & { _id: Types.ObjectId; createdAt: Date };
export const Lead = (models.Lead || model("Lead", leadSchema)) as Model<InferSchemaType<typeof leadSchema>>;

/**
 * A connected website/form source. The secret is shown once and stored as a
 * SHA-256 hash; requests authenticate with `Authorization: Bearer <secret>`.
 */
const leadSourceSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    name: { type: String, required: true, maxlength: 120 },
    /** Public, non-secret id used in the endpoint URL. */
    slug: { type: String, required: true, maxlength: 40 },
    defaultCategory: { type: String, enum: LEAD_CATEGORIES, required: true },
    /** incoming field name → lead field (e.g. "your-name" → "name"). */
    fieldMap: { type: Schema.Types.Mixed, default: () => ({}) },
    secretHash: { type: String, required: true },
    secretHint: { type: String, maxlength: 12, default: "" },
    active: { type: Boolean, default: true },
    lastReceivedAt: { type: Date, default: null },
    receivedCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);
leadSourceSchema.index({ slug: 1 }, { unique: true });
leadSourceSchema.index({ organizationId: 1, name: 1 });
export type LeadSourceDoc = InferSchemaType<typeof leadSourceSchema> & { _id: Types.ObjectId; createdAt: Date };
export const LeadSource = (models.LeadSource || model("LeadSource", leadSourceSchema)) as Model<InferSchemaType<typeof leadSourceSchema>>;

/** Intake log (no secrets, no full payloads). Kept 90 days. */
const submissionLogSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, default: null },
    sourceId: { type: Schema.Types.ObjectId, default: null },
    sourceSlug: { type: String, maxlength: 40, default: "" },
    outcome: { type: String, enum: ["accepted", "duplicate", "rejected", "unauthorized", "rate_limited"], required: true },
    externalId: { type: String, maxlength: 200, default: null },
    leadId: { type: Schema.Types.ObjectId, default: null },
    error: { type: String, maxlength: 300, default: null },
    receivedAt: { type: Date, required: true, default: () => new Date() },
  },
  { versionKey: false },
);
submissionLogSchema.index({ organizationId: 1, sourceId: 1, receivedAt: -1 });
submissionLogSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
export const LeadSubmissionLog = (models.LeadSubmissionLog || model("LeadSubmissionLog", submissionLogSchema)) as Model<InferSchemaType<typeof submissionLogSchema>>;
