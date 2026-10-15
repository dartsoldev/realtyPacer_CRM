import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { ROLES, USER_STATUSES } from "@/lib/domain/constants";

const userSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    /** Always stored normalised (see normalizeEmail); unique across the system. */
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** Argon2id PHC string. Never selected by default. */
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: USER_STATUSES, required: true, default: "invited" },
    /** Extra operational permissions explicitly granted to STAFF users. */
    permissionGrants: { type: [String], default: [] },
    emailVerifiedAt: { type: Date, default: null },
    /** Incremented to revoke every existing session for this user. */
    sessionVersion: { type: Number, required: true, default: 0 },
    passwordChangedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ organizationId: 1, createdAt: -1 });
userSchema.index({ organizationId: 1, role: 1, status: 1 });

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };

export const User: Model<InferSchemaType<typeof userSchema>> = models.User || model("User", userSchema);
