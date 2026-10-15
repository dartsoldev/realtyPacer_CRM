import "server-only";
import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

/** Fixed-window counters shared by every app instance. Keys are hashed. */
const rateLimitSchema = new Schema(
  {
    key: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

rateLimitSchema.index({ key: 1 }, { unique: true });
rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimit = (models.RateLimit ||
  model("RateLimit", rateLimitSchema)) as Model<InferSchemaType<typeof rateLimitSchema>>;
