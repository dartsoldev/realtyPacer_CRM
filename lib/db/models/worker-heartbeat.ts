import "server-only";
import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/** Liveness record written by each background worker process (see scripts/worker.ts). */
const heartbeatSchema = new Schema(
  {
    _id: { type: String, required: true }, // worker name, e.g. "outbox"
    host: { type: String, maxlength: 200, default: "" },
    beatAt: { type: Date, required: true },
    lastRunAt: { type: Date, default: null },
    lastResult: { type: Schema.Types.Mixed, default: null },
  },
  { versionKey: false },
);

export const WorkerHeartbeat = (models.WorkerHeartbeat || model("WorkerHeartbeat", heartbeatSchema)) as Model<InferSchemaType<typeof heartbeatSchema>>;
