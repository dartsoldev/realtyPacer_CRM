import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { ACTIVITY_TYPES, CALL_OUTCOMES } from "@/lib/domain/constants";

/**
 * Business timeline (customer / booking history). Security and admin events
 * stay in AuditEvent. Content is plain text and rendered escaped.
 */
const activitySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    /** "office": staff only. Cleaners never receive activity history in this phase. */
    visibility: { type: String, enum: ["office"], default: "office" },
    content: { type: String, maxlength: 2000, default: "" },
    callOutcome: { type: String, enum: [...CALL_OUTCOMES, null], default: null },
    /** Small, non-sensitive structured details (e.g. {from, to}). */
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
    /** Prevents duplicate events when an idempotent request is retried. */
    dedupeKey: { type: String, default: null },
    occurredAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, minimize: false },
);

activitySchema.index({ organizationId: 1, customerId: 1, occurredAt: -1, _id: -1 });
activitySchema.index({ organizationId: 1, bookingId: 1, occurredAt: -1, _id: -1 });
activitySchema.index({ organizationId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });

export type ActivityDoc = InferSchemaType<typeof activitySchema> & { _id: Types.ObjectId };

export const Activity = (models.Activity || model("Activity", activitySchema)) as Model<InferSchemaType<typeof activitySchema>>;
