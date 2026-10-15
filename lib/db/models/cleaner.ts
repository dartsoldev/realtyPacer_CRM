import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";

/**
 * A cleaner (service provider). Not a login account; may be explicitly linked
 * to one CLEANER user so they can see their assigned jobs.
 */
const cleanerSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    searchName: { type: String, required: true, maxlength: 120 },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: null },
    phone: { type: String, trim: true, maxlength: 20, default: null },
    phoneDisplay: { type: String, trim: true, maxlength: 40, default: null },
    active: { type: Boolean, default: true },
    serviceAreas: { type: [String], default: [] },
    notes: { type: String, maxlength: 5000, default: "" },
    customFields: { type: Schema.Types.Mixed, default: () => ({}) },
    linkedUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    /**
     * Scheduling lock: every transaction that assigns this cleaner (or changes
     * their active state) increments it, so concurrent assignments of the same
     * cleaner write-conflict and are retried/serialised by MongoDB.
     */
    scheduleRevision: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, minimize: false },
);

cleanerSchema.index({ organizationId: 1, archivedAt: 1, active: 1, searchName: 1, _id: 1 });
// One cleaner record per linked user (users belong to exactly one organization), never ambiguous.
cleanerSchema.index({ linkedUserId: 1 }, { unique: true, partialFilterExpression: { linkedUserId: { $type: "objectId" } } });

export type CleanerDoc = InferSchemaType<typeof cleanerSchema> & { _id: Types.ObjectId };

export const Cleaner = (models.Cleaner || model("Cleaner", cleanerSchema)) as Model<InferSchemaType<typeof cleanerSchema>>;
