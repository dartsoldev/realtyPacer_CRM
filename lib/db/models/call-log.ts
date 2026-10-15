import "server-only";
import { Schema, model, models, type InferSchemaType, type Model, type Types } from "mongoose";
import { CALL_DIRECTIONS, CALL_OUTCOMES, CALL_STATUSES } from "@/lib/domain/constants";

/**
 * One phone call with a customer or cleaner. Phone-app calls are logged by a
 * person (status "logged"); browser calls are created by the server before
 * dialing and updated only by signature-validated provider callbacks.
 * Clicking a tel: link never creates or completes a record.
 */
const callLogSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    targetType: { type: String, enum: ["customer", "cleaner"], required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null },
    cleanerId: { type: Schema.Types.ObjectId, ref: "Cleaner", default: null },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    /** Destination taken from the customer/cleaner record on the server — never from the browser. */
    toNumber: { type: String, default: null, maxlength: 20 },
    direction: { type: String, enum: CALL_DIRECTIONS, required: true },
    channel: { type: String, enum: ["phone_app", "browser"], required: true },
    status: { type: String, enum: CALL_STATUSES, required: true },
    outcome: { type: String, enum: [...CALL_OUTCOMES, null], default: null },
    durationSeconds: { type: Number, default: null, min: 0, max: 24 * 3600 },
    notes: { type: String, default: "", maxlength: 2000 },
    occurredAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    provider: { type: String, enum: ["twilio", null], default: null },
    /** Parent (browser leg) and child (PSTN leg) call ids from the provider. */
    providerCallSid: { type: String, default: null },
    providerChildSid: { type: String, default: null },
    /** Highest provider SequenceNumber applied — older/duplicate callbacks are ignored. */
    lastSequence: { type: Number, default: -1 },
    idempotencyKey: { type: String, default: null },
  },
  { timestamps: true },
);

callLogSchema.index({ organizationId: 1, customerId: 1, occurredAt: -1 });
callLogSchema.index({ organizationId: 1, cleanerId: 1, occurredAt: -1 });
callLogSchema.index({ organizationId: 1, bookingId: 1, occurredAt: -1 });
callLogSchema.index({ providerCallSid: 1 }, { unique: true, partialFilterExpression: { providerCallSid: { $type: "string" } } });
callLogSchema.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });

export type CallLogDoc = InferSchemaType<typeof callLogSchema> & { _id: Types.ObjectId; createdAt: Date };
export const CallLog = (models.CallLog || model("CallLog", callLogSchema)) as Model<InferSchemaType<typeof callLogSchema>>;
