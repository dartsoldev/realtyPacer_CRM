import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";

export const NOTIFICATION_TYPES = ["assignment_added", "assignment_removed", "booking_rescheduled", "booking_cancelled"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * In-app notification for one user. Holds only what that user may already see
 * (reference, local time, city). Opening the link re-checks authorization.
 */
const notificationSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, default: "", maxlength: 500 },
    readAt: { type: Date, default: null },
    dedupeKey: { type: String, required: true, maxlength: 200 },
  },
  { timestamps: true },
);

notificationSchema.index({ organizationId: 1, userId: 1, readAt: 1, createdAt: -1 });
notificationSchema.index({ organizationId: 1, dedupeKey: 1 }, { unique: true });
// Old notifications expire after 180 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

export type NotificationDoc = InferSchemaType<typeof notificationSchema> & { _id: Types.ObjectId; createdAt: Date };
export const Notification = (models.Notification || model("Notification", notificationSchema)) as Model<InferSchemaType<typeof notificationSchema>>;
