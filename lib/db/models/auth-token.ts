import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { AUTH_TOKEN_PURPOSES } from "@/lib/domain/constants";

const deliverySchema = new Schema(
  {
    status: { type: String, enum: ["pending", "sent", "failed", "not_sent"], default: "pending" },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    /** Safe, non-secret failure category (e.g. "SMTP_AUTH", "CONNECTION"). */
    lastErrorCode: { type: String, default: null },
  },
  { _id: false },
);

/**
 * One-time token. Only the SHA-256 hash of the random token is stored; the
 * raw token exists only in the emailed link. Expiry is always checked in
 * application logic — the TTL index is housekeeping only.
 */
const authTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    purpose: { type: String, enum: AUTH_TOKEN_PURPOSES, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    /** Set when superseded by a newer token of the same purpose. */
    revokedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    delivery: { type: deliverySchema, default: () => ({}) },
  },
  { timestamps: true },
);

authTokenSchema.index({ tokenHash: 1 }, { unique: true });
authTokenSchema.index({ userId: 1, purpose: 1, createdAt: -1 });
// Remove token records 7 days after expiry (keeps "already used" messaging accurate meanwhile).
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

export type AuthTokenDoc = InferSchemaType<typeof authTokenSchema> & { _id: Types.ObjectId };

export const AuthToken: Model<InferSchemaType<typeof authTokenSchema>> =
  models.AuthToken || model("AuthToken", authTokenSchema);
