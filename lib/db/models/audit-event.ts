import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";

/** Append-only audit trail. Metadata is sanitised by the audit service. */
const auditEventSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true, maxlength: 80 },
    entityType: { type: String, required: true, maxlength: 40 },
    entityId: { type: Schema.Types.ObjectId, default: null },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) },
    createdAt: { type: Date, default: () => new Date(), immutable: true },
  },
  { timestamps: false, minimize: false },
);

auditEventSchema.index({ organizationId: 1, createdAt: -1 });
auditEventSchema.index({ organizationId: 1, entityType: 1, entityId: 1, createdAt: -1 });
auditEventSchema.index({ organizationId: 1, action: 1, createdAt: -1 });

export type AuditEventDoc = InferSchemaType<typeof auditEventSchema> & { _id: Types.ObjectId };

export const AuditEvent: Model<InferSchemaType<typeof auditEventSchema>> =
  models.AuditEvent || model("AuditEvent", auditEventSchema);
