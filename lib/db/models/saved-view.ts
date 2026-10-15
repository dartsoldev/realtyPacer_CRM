import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";

/**
 * A saved report/list configuration. The definition is re-validated against
 * the current field registry and the viewer's permissions every time it runs,
 * so a view can never grant access by itself.
 */
const savedViewSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    reportType: { type: String, enum: ["service", "cash", "customers"], required: true },
    /** Validated ReportDefinition JSON (filters, statuses, date range/preset, sort, columns). */
    definition: { type: Schema.Types.Mixed, required: true },
    visibility: { type: String, enum: ["private", "shared"], default: "private" },
  },
  { timestamps: true, minimize: false },
);

savedViewSchema.index({ organizationId: 1, reportType: 1, visibility: 1, name: 1 });
savedViewSchema.index({ organizationId: 1, ownerId: 1, reportType: 1 });

export type SavedViewDoc = InferSchemaType<typeof savedViewSchema> & { _id: Types.ObjectId };

export const SavedView = (models.SavedView || model("SavedView", savedViewSchema)) as Model<InferSchemaType<typeof savedViewSchema>>;
