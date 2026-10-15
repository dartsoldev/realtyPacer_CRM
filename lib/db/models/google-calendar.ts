import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";

/**
 * One Google Calendar connection per organization (outbound sync: CRM → Google).
 * Tokens are AES-256-GCM encrypted with TOKEN_ENCRYPTION_KEY.
 */
const connectionSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    connectedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    googleEmail: { type: String, default: "", maxlength: 254 },
    refreshTokenEnc: { type: String, default: null },
    accessTokenEnc: { type: String, default: null },
    accessTokenExpiresAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },
    calendarId: { type: String, default: null, maxlength: 300 },
    calendarName: { type: String, default: "", maxlength: 300 },
    /** connected | needs_reauth (token revoked/expired) | disconnected */
    status: { type: String, enum: ["connected", "needs_reauth", "disconnected"], default: "connected" },
    lastSyncAt: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 300 },
    lastErrorAt: { type: Date, default: null },
    lastVerifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
connectionSchema.index({ organizationId: 1 }, { unique: true });

export const GoogleCalendarConnection = (models.GoogleCalendarConnection || model("GoogleCalendarConnection", connectionSchema)) as Model<InferSchemaType<typeof connectionSchema>>;
export type GoogleConnectionDoc = InferSchemaType<typeof connectionSchema> & { _id: Types.ObjectId };

/** Short-lived OAuth state (CSRF) with the PKCE verifier; expires after 10 minutes. */
const oauthStateSchema = new Schema({
  stateHash: { type: String, required: true },
  organizationId: { type: Schema.Types.ObjectId, required: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  codeVerifierEnc: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});
oauthStateSchema.index({ stateHash: 1 }, { unique: true });
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const OAuthState = (models.OAuthState || model("OAuthState", oauthStateSchema)) as Model<InferSchemaType<typeof oauthStateSchema>>;

/**
 * Sync state of one booking's Google event. One document per booking, so
 * repeated change notifications collapse into a single pending job.
 */
const calendarSyncSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    eventId: { type: String, default: null, maxlength: 1024 },
    calendarId: { type: String, default: null, maxlength: 300 },
    /** What the next run must do. */
    action: { type: String, enum: ["upsert", "delete"], default: "upsert" },
    status: { type: String, enum: ["pending", "processing", "synced", "removed", "failed"], default: "pending" },
    /** Bumped on every request; a run only marks “synced” if nothing newer arrived meanwhile. */
    requestSeq: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: null, maxlength: 300 },
    lastSyncedAt: { type: Date, default: null },
    /** Result of the periodic check of Google's copy (external edits are reported, never imported). */
    externalState: { type: String, enum: ["ok", "changed_in_google", "deleted_in_google", null], default: null },
  },
  { timestamps: true },
);
calendarSyncSchema.index({ organizationId: 1, bookingId: 1 }, { unique: true });
calendarSyncSchema.index({ status: 1, nextAttemptAt: 1 });
calendarSyncSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });

export const CalendarSync = (models.CalendarSync || model("CalendarSync", calendarSyncSchema)) as Model<InferSchemaType<typeof calendarSyncSchema>>;
export type CalendarSyncDoc = InferSchemaType<typeof calendarSyncSchema> & { _id: Types.ObjectId; updatedAt: Date };
