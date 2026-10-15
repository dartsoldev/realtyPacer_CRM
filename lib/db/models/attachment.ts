import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";

export const ATTACHMENT_PARENTS = ["address", "booking"] as const;
export const ATTACHMENT_CATEGORIES = ["property_photo", "before_photo", "after_photo", "document"] as const;
export type AttachmentCategory = (typeof ATTACHMENT_CATEGORIES)[number];

/**
 * Metadata for a privately stored file. The bytes live in object storage under
 * a random key; the record is "ready" only after the server has verified the
 * uploaded object (size, file signature, image decoding).
 */
const attachmentSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    parentType: { type: String, enum: ATTACHMENT_PARENTS, required: true },
    parentId: { type: Schema.Types.ObjectId, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    category: { type: String, enum: ATTACHMENT_CATEGORIES, required: true },
    fileName: { type: String, required: true, maxlength: 120 },
    mimeType: { type: String, required: true, maxlength: 60 },
    size: { type: Number, required: true, min: 1 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    storageKey: { type: String, required: true, maxlength: 300 },
    thumbKey: { type: String, default: null, maxlength: 300 },
    /** "assigned_cleaners": also visible to cleaners on the related job. Documents default to office-only. */
    visibility: { type: String, enum: ["office", "assigned_cleaners"], default: "office" },
    status: { type: String, enum: ["pending", "ready", "deleted"], default: "pending" },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    readyAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

attachmentSchema.index({ organizationId: 1, parentType: 1, parentId: 1, status: 1, createdAt: -1 });
attachmentSchema.index({ status: 1, createdAt: 1 });
attachmentSchema.index({ storageKey: 1 }, { unique: true });

export type AttachmentDoc = InferSchemaType<typeof attachmentSchema> & { _id: Types.ObjectId; createdAt: Date };
export const Attachment = (models.Attachment || model("Attachment", attachmentSchema)) as Model<InferSchemaType<typeof attachmentSchema>>;
