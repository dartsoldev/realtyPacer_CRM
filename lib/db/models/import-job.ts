import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";

export const IMPORT_DECISIONS = ["create", "skip", "update"] as const;
export const IMPORT_ROW_RESULTS = ["created", "updated", "skipped", "failed"] as const;

const rowSchema = new Schema(
  {
    n: { type: Number, required: true }, // 1-based data row number in the file
    raw: { type: [String], default: [] },
    problems: { type: [String], default: [] },
    duplicates: { type: [{ customerId: Schema.Types.ObjectId, name: String, matchedOn: [String] }], default: [] },
    decision: { type: String, enum: [...IMPORT_DECISIONS, null], default: null },
    targetId: { type: Schema.Types.ObjectId, default: null },
    /** Fields the user chose to overwrite on update (non-empty existing values are kept otherwise). */
    overwrite: { type: [String], default: [] },
    result: { type: String, enum: [...IMPORT_ROW_RESULTS, null], default: null },
    resultId: { type: Schema.Types.ObjectId, default: null },
    resultError: { type: String, default: null, maxlength: 300 },
  },
  { _id: false },
);

/**
 * Customer CSV import: upload → map → preview/validate → decide → run in
 * batches. Rows keep their own result so a retried batch never repeats work.
 * Expires after 14 days (no long-term copy of imported files).
 */
const importJobSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: ["customers"], default: "customers" },
    fileName: { type: String, maxlength: 200, default: "" },
    headers: { type: [String], default: [] },
    mapping: { type: Schema.Types.Mixed, default: () => ({}) },
    status: { type: String, enum: ["uploaded", "previewed", "running", "completed"], default: "uploaded" },
    rows: { type: [rowSchema], default: [] },
    revision: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 14 * 24 * 3600 * 1000) },
  },
  { timestamps: true },
);

importJobSchema.index({ organizationId: 1, createdAt: -1 });
importJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type ImportJobDoc = InferSchemaType<typeof importJobSchema> & { _id: Types.ObjectId; createdAt: Date };
export const ImportJob = (models.ImportJob || model("ImportJob", importJobSchema)) as Model<InferSchemaType<typeof importJobSchema>>;
