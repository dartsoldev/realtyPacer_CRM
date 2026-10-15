import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";

export const OUTBOX_KINDS = ["booking_confirmation", "booking_changed", "booking_cancelled", "password_changed"] as const;
export const OUTBOX_STATUSES = ["pending", "sending", "sent", "failed", "cancelled"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * Persistent email outbox. Content is rendered when queued (a snapshot of what
 * the user previewed); the worker delivers it with retries and backoff.
 * `dedupeKey` makes enqueueing idempotent, so retried requests never send twice.
 */
const outboxSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    kind: { type: String, enum: OUTBOX_KINDS, required: true },
    to: { type: String, required: true, maxlength: 254 },
    subject: { type: String, required: true, maxlength: 300 },
    html: { type: String, required: true, maxlength: 200_000 },
    text: { type: String, required: true, maxlength: 100_000 },
    status: { type: String, enum: OUTBOX_STATUSES, default: "pending" },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 6 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lockedUntil: { type: Date, default: null },
    /** Coarse, non-secret error category from the mailer (e.g. SMTP_CONNECTION). */
    lastError: { type: String, default: null, maxlength: 60 },
    sentAt: { type: Date, default: null },
    providerMessageId: { type: String, default: null, maxlength: 300 },
    relatedType: { type: String, default: null, maxlength: 20 },
    relatedId: { type: Schema.Types.ObjectId, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    dedupeKey: { type: String, required: true, maxlength: 200 },
  },
  { timestamps: true },
);

outboxSchema.index({ organizationId: 1, dedupeKey: 1 }, { unique: true });
outboxSchema.index({ status: 1, nextAttemptAt: 1 });
outboxSchema.index({ organizationId: 1, relatedType: 1, relatedId: 1, createdAt: -1 });
outboxSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

export type OutboxDoc = InferSchemaType<typeof outboxSchema> & { _id: Types.ObjectId; createdAt: Date };
export const OutboxMessage = (models.OutboxMessage || model("OutboxMessage", outboxSchema)) as Model<InferSchemaType<typeof outboxSchema>>;
