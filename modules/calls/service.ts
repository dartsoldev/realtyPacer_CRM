import "server-only";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Activity } from "@/lib/db/models/activity";
import { Booking } from "@/lib/db/models/booking";
import { CallLog, type CallLogDoc } from "@/lib/db/models/call-log";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { User } from "@/lib/db/models/user";
import { CALL_DIRECTIONS, MANUAL_CALL_OUTCOMES, type CallOutcome, type CallStatus } from "@/lib/domain/constants";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { getCoreEnv, getTwilioEnv } from "@/lib/env";
import { AppError, Errors } from "@/lib/http/errors";
import { logger } from "@/lib/logger";
import { enforce, RATE_LIMITS } from "@/lib/security/rate-limit";
import { createVoiceToken, dialTwiml, rejectTwiml, voiceIdentity, VOICE_TOKEN_TTL_SECONDS } from "@/lib/telephony/twilio";
import { recordActivity } from "@/modules/activities/service";
import { recordAudit } from "@/modules/audit/service";

const objectId = z.string().regex(OBJECT_ID_RE, "Invalid id");
const target = { targetType: z.enum(["customer", "cleaner"]), targetId: objectId, bookingId: objectId.optional() };

export const logCallSchema = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/),
    ...target,
    direction: z.enum(CALL_DIRECTIONS),
    outcome: z.enum(MANUAL_CALL_OUTCOMES),
    durationMinutes: z.number().int().min(0).max(600).optional(),
    notes: z.string().trim().max(2000).default(""),
  })
  .strict();

export const browserCallSchema = z.object(target).strict();

export const updateCallSchema = z.object({ outcome: z.enum(MANUAL_CALL_OUTCOMES).optional(), notes: z.string().trim().max(2000).optional() }).strict();

type Target = { targetType: "customer" | "cleaner"; customerId: Types.ObjectId | null; cleanerId: Types.ObjectId | null; bookingId: Types.ObjectId | null; phone: string | null; name: string };

/** Loads the person being called inside the user's organization, enforcing read access. */
async function resolveTarget(user: CurrentUser, input: { targetType: "customer" | "cleaner"; targetId: string; bookingId?: string }): Promise<Target> {
  const orgId = new Types.ObjectId(user.organizationId);
  const bookingId = input.bookingId ? new Types.ObjectId(input.bookingId) : null;
  let booking: { customerId: Types.ObjectId; assignedCleanerIds: Types.ObjectId[] } | null = null;
  if (bookingId) {
    booking = await Booking.findOne({ _id: bookingId, organizationId: orgId }).select("customerId assignedCleanerIds").lean();
    if (!booking) throw Errors.notFound("Booking");
  }
  if (input.targetType === "customer") {
    if (!user.permissions.has("customers:read")) throw Errors.forbidden();
    const c = await Customer.findOne({ _id: input.targetId, organizationId: orgId }).select("phone name").lean();
    if (!c) throw Errors.notFound("Customer");
    if (booking && String(booking.customerId) !== String(c._id)) throw Errors.validation("That booking belongs to another customer.");
    return { targetType: "customer", customerId: c._id, cleanerId: null, bookingId, phone: c.phone ?? null, name: c.name };
  }
  if (!user.permissions.has("cleaners:read")) throw Errors.forbidden();
  const cl = await Cleaner.findOne({ _id: input.targetId, organizationId: orgId }).select("phone name").lean();
  if (!cl) throw Errors.notFound("Cleaner");
  if (booking && !booking.assignedCleanerIds.some((id) => String(id) === String(cl._id))) throw Errors.validation("That cleaner isn't assigned to this booking.");
  return { targetType: "cleaner", customerId: booking?.customerId ?? null, cleanerId: cl._id, bookingId, phone: cl.phone ?? null, name: cl.name };
}

async function mirrorActivity(log: { _id: Types.ObjectId; organizationId: Types.ObjectId; actorId: Types.ObjectId; customerId: Types.ObjectId | null; bookingId: Types.ObjectId | null; targetType: string; direction: string; channel: string; outcome: string | null; durationSeconds: number | null; notes: string }, targetName: string) {
  if (!log.customerId && !log.bookingId) return; // cleaner-only calls live in the cleaner's call list
  await recordActivity({
    organizationId: log.organizationId,
    actorId: log.actorId,
    type: "call",
    customerId: log.customerId,
    bookingId: log.bookingId,
    content: log.notes,
    callOutcome: (log.outcome as CallOutcome | null) ?? null,
    metadata: { callLogId: String(log._id), direction: log.direction, channel: log.channel, target: log.targetType, targetName, durationSeconds: log.durationSeconds },
    dedupeKey: `call:${log._id}`,
  });
}

/** A call made from the user's own phone, recorded by hand. Idempotent per key. */
export async function logCall(user: CurrentUser, raw: unknown) {
  if (!user.permissions.has("calls:log")) throw Errors.forbidden();
  const input = logCallSchema.parse(raw);
  await connectDb();
  const t = await resolveTarget(user, input);
  const orgId = new Types.ObjectId(user.organizationId);
  const existing = await CallLog.findOne({ organizationId: orgId, idempotencyKey: input.idempotencyKey }).select("_id").lean();
  if (existing) return { id: String(existing._id), created: false };
  try {
    const [doc] = await CallLog.create([
      {
        organizationId: orgId,
        actorId: new Types.ObjectId(user.id),
        targetType: t.targetType,
        customerId: t.customerId,
        cleanerId: t.cleanerId,
        bookingId: t.bookingId,
        toNumber: t.phone,
        direction: input.direction,
        channel: "phone_app",
        status: "logged",
        outcome: input.outcome,
        durationSeconds: input.durationMinutes !== undefined ? input.durationMinutes * 60 : null,
        notes: input.notes,
        occurredAt: new Date(),
        idempotencyKey: input.idempotencyKey,
      },
    ]);
    await mirrorActivity(doc!.toObject() as never, t.name);
    return { id: String(doc!._id), created: true };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const again = await CallLog.findOne({ organizationId: orgId, idempotencyKey: input.idempotencyKey }).select("_id").lean();
      if (again) return { id: String(again._id), created: false };
    }
    throw err;
  }
}

export async function updateCall(user: CurrentUser, id: string, raw: unknown) {
  if (!user.permissions.has("calls:log")) throw Errors.forbidden();
  const input = updateCallSchema.parse(raw);
  await connectDb();
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Call");
  const log = await CallLog.findOne({ _id: id, organizationId: user.organizationId }).lean();
  if (!log) throw Errors.notFound("Call");
  if (String(log.actorId) !== user.id && user.role !== "SUPERADMIN" && user.role !== "ADMIN") throw Errors.forbidden("Only the person who made the call can edit it.");
  const set: Record<string, unknown> = {};
  if (input.notes !== undefined) set.notes = input.notes;
  // Provider-reported failures stay as reported; a connected call can be refined (e.g. voicemail).
  if (input.outcome && (log.channel === "phone_app" || log.status === "completed")) set.outcome = input.outcome;
  await CallLog.updateOne({ _id: log._id }, { $set: set });
  await Activity.updateOne({ organizationId: log.organizationId, dedupeKey: `call:${log._id}` }, { $set: { ...(set.notes !== undefined ? { content: set.notes } : {}), ...(set.outcome ? { callOutcome: set.outcome } : {}) } });
  return { ok: true };
}

export type CallItem = {
  id: string;
  occurredAt: string;
  direction: string;
  channel: "phone_app" | "browser";
  status: CallStatus;
  outcome: CallOutcome | null;
  durationSeconds: number | null;
  notes: string;
  actorName: string | null;
  bookingId: string | null;
  mine: boolean;
};

export async function listCalls(user: CurrentUser, q: { customerId?: string; cleanerId?: string; bookingId?: string }) {
  if (!user.permissions.has("calls:log")) throw Errors.forbidden();
  await connectDb();
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(user.organizationId) };
  if (q.customerId && OBJECT_ID_RE.test(q.customerId)) filter.customerId = new Types.ObjectId(q.customerId);
  else if (q.cleanerId && OBJECT_ID_RE.test(q.cleanerId)) filter.cleanerId = new Types.ObjectId(q.cleanerId);
  else if (q.bookingId && OBJECT_ID_RE.test(q.bookingId)) filter.bookingId = new Types.ObjectId(q.bookingId);
  else throw Errors.validation("Choose a customer, cleaner or booking.");
  if (filter.customerId && !user.permissions.has("customers:read")) throw Errors.forbidden();
  if (filter.cleanerId && !user.permissions.has("cleaners:read")) throw Errors.forbidden();
  const rows = (await CallLog.find(filter).sort({ occurredAt: -1, _id: -1 }).limit(50).lean()) as CallLogDoc[];
  const actors = new Map((await User.find({ _id: { $in: rows.map((r) => r.actorId) }, organizationId: user.organizationId }).select("name").lean()).map((u) => [String(u._id), u.name]));
  return rows.map<CallItem>((r) => ({
    id: String(r._id),
    occurredAt: r.occurredAt.toISOString(),
    direction: r.direction,
    channel: r.channel as CallItem["channel"],
    status: r.status as CallStatus,
    outcome: (r.outcome as CallOutcome | null) ?? null,
    durationSeconds: r.durationSeconds ?? null,
    notes: r.notes ?? "",
    actorName: actors.get(String(r.actorId)) ?? "Former user",
    bookingId: r.bookingId ? String(r.bookingId) : null,
    mine: String(r.actorId) === user.id,
  }));
}

// ---------------------------------------------------------------------------
// Browser calling (Twilio Voice)
// ---------------------------------------------------------------------------

/** Whether this user can place browser calls right now (UI hint; the API re-checks). */
export function browserCallingAvailable(user: CurrentUser): boolean {
  try {
    return Boolean(getTwilioEnv()) && user.permissions.has("calls:browser");
  } catch {
    return false;
  }
}

function allowedDestination(e164: string, countries: string[]): boolean {
  const p = parsePhoneNumberFromString(e164);
  if (!p || !p.isValid()) return false;
  // NANP numbers without a resolvable region are treated as CA/US only when one of those is allowed.
  const region = p.country ?? (p.countryCallingCode === "1" ? "US" : null);
  return Boolean(region && countries.includes(region));
}

/**
 * Starts an outbound browser call: checks permission, configuration, rate
 * limits and the destination, records the call, and returns a short-lived
 * token. The browser sends only the call id; the server dials the stored number.
 */
export async function startBrowserCall(user: CurrentUser, raw: unknown) {
  if (!user.permissions.has("calls:browser") || !user.permissions.has("calls:log")) throw Errors.forbidden("Browser calling isn't enabled for your account.");
  const env = getTwilioEnv();
  if (!env) throw new AppError(503, "CALLING_NOT_CONFIGURED", "Browser calling isn't set up. Use your phone instead.");
  const input = browserCallSchema.parse(raw);
  await connectDb();
  await enforce([
    [RATE_LIMITS.browserCallByUser, user.id],
    [RATE_LIMITS.browserCallByOrg, user.organizationId],
  ]);
  const t = await resolveTarget(user, input);
  if (!t.phone) throw Errors.validation("There's no phone number on file.");
  if (!allowedDestination(t.phone, env.CALLING_ALLOWED_COUNTRIES)) throw new AppError(422, "DESTINATION_NOT_ALLOWED", "Calls to this number aren't allowed from RealtyPacer. Use your phone instead.");
  const [doc] = await CallLog.create([
    {
      organizationId: new Types.ObjectId(user.organizationId),
      actorId: new Types.ObjectId(user.id),
      targetType: t.targetType,
      customerId: t.customerId,
      cleanerId: t.cleanerId,
      bookingId: t.bookingId,
      toNumber: t.phone,
      direction: "outbound",
      channel: "browser",
      status: "initiated",
      occurredAt: new Date(),
      provider: "twilio",
    },
  ]);
  await mirrorActivity({ ...(doc!.toObject() as object), notes: "Browser call started" } as never, t.name);
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "call.browser_started", entityType: "call", entityId: doc!._id, metadata: { target: t.targetType } });
  return { callLogId: String(doc!._id), token: createVoiceToken(env, voiceIdentity(user.id)), expiresInSeconds: VOICE_TOKEN_TTL_SECONDS, targetName: t.name };
}

/** A new token for an in-progress session (tokenWillExpire). */
export function refreshVoiceToken(user: CurrentUser) {
  if (!user.permissions.has("calls:browser")) throw Errors.forbidden();
  const env = getTwilioEnv();
  if (!env) throw new AppError(503, "CALLING_NOT_CONFIGURED", "Browser calling isn't set up.");
  return { token: createVoiceToken(env, voiceIdentity(user.id)), expiresInSeconds: VOICE_TOKEN_TTL_SECONDS };
}

const CALL_START_WINDOW_MS = 2 * 60 * 1000;

/**
 * TwiML for the outbound leg. Twilio calls this after `device.connect`; the
 * request signature has already been validated. The only browser-supplied
 * value used is `callLogId`, and it must belong to the identity that placed
 * the call, be fresh and unused.
 */
export async function voiceTwiml(params: Record<string, string>): Promise<string> {
  const env = getTwilioEnv();
  if (!env) return rejectTwiml("Calling is not available.");
  await connectDb();
  const id = params.callLogId ?? "";
  const from = params.From ?? params.Caller ?? "";
  const callSid = params.CallSid ?? "";
  const caller = /^client:rp_([a-f0-9]{24})$/.exec(from)?.[1];
  if (!OBJECT_ID_RE.test(id) || !/^CA[0-9a-f]{32}$/.test(callSid) || !caller) return rejectTwiml("This call could not be placed.");
  // Identity is part of the atomic claim, so a forged request can't burn someone else's call.
  const log = await CallLog.findOneAndUpdate(
    { _id: id, actorId: new Types.ObjectId(caller), channel: "browser", status: "initiated", providerCallSid: null, createdAt: { $gte: new Date(Date.now() - CALL_START_WINDOW_MS) } },
    { $set: { providerCallSid: callSid } },
    { returnDocument: "after" },
  ).lean();
  if (!log || from !== `client:${voiceIdentity(String(log.actorId))}` || !log.toNumber || !allowedDestination(log.toNumber, env.CALLING_ALLOWED_COUNTRIES)) {
    logger.warn("telephony.voice_rejected", { reason: !log ? "unknown_or_used_call" : "identity_or_destination", callLogId: id });
    return rejectTwiml("This call could not be placed.");
  }
  const base = getCoreEnv().APP_URL;
  return dialTwiml({ callerId: env.TWILIO_CALLER_ID, to: log.toNumber, statusCallbackUrl: `${base}/api/v1/telephony/twilio/status` });
}

const TERMINAL: CallStatus[] = ["completed", "busy", "no_answer", "failed", "canceled"];
const PROVIDER_STATUS: Record<string, CallStatus> = {
  queued: "initiated",
  initiated: "initiated",
  ringing: "ringing",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "canceled",
};

/**
 * Status callback for the dialed (child) leg. Idempotent: duplicates and
 * out-of-order events (lower SequenceNumber) are ignored, and a terminal
 * status never moves back.
 */
export async function applyCallStatus(params: Record<string, string>): Promise<{ applied: boolean }> {
  await connectDb();
  const parentSid = params.ParentCallSid ?? "";
  const status = PROVIDER_STATUS[params.CallStatus ?? ""];
  const seq = Number.parseInt(params.SequenceNumber ?? "", 10);
  if (!/^CA[0-9a-f]{32}$/.test(parentSid) || !status || !Number.isInteger(seq) || seq < 0) return { applied: false };
  const log = await CallLog.findOne({ providerCallSid: parentSid }).lean();
  if (!log) return { applied: false };
  const set: Record<string, unknown> = { lastSequence: seq };
  if (/^CA[0-9a-f]{32}$/.test(params.CallSid ?? "")) set.providerChildSid = params.CallSid;
  const terminal = TERMINAL.includes(status);
  // A completed call is "answered" when the dialed party picked up (in-progress was reached or duration > 0).
  const duration = Number.parseInt(params.CallDuration ?? "", 10);
  set.status = status;
  if (terminal) {
    set.endedAt = new Date();
    if (Number.isInteger(duration) && duration >= 0) set.durationSeconds = duration;
    set.outcome = status === "completed" ? (duration > 0 || log.status === "in_progress" ? "answered" : "no_answer") : status === "no_answer" ? "no_answer" : status;
  }
  const res = await CallLog.updateOne(
    { _id: log._id, lastSequence: { $lt: seq }, status: { $nin: TERMINAL } },
    { $set: set },
  );
  if (res.modifiedCount === 0) return { applied: false };
  if (terminal) {
    await Activity.updateOne(
      { organizationId: log.organizationId, dedupeKey: `call:${log._id}` },
      { $set: { callOutcome: set.outcome, content: log.notes || `Browser call ${status.replace("_", " ")}`, "metadata.durationSeconds": set.durationSeconds ?? null } },
    );
  }
  return { applied: true };
}

/** The browser reports a local failure before Twilio ever connected (e.g. microphone denied). */
export async function markBrowserCallFailed(user: CurrentUser, id: string, reason: string) {
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Call");
  await connectDb();
  await CallLog.updateOne(
    { _id: id, organizationId: user.organizationId, actorId: user.id, channel: "browser", status: "initiated", providerCallSid: null },
    { $set: { status: "failed", outcome: "failed", endedAt: new Date(), notes: `Not connected: ${reason.slice(0, 120)}` } },
  );
  await Activity.updateOne({ organizationId: user.organizationId, dedupeKey: `call:${id}`, callOutcome: null }, { $set: { callOutcome: "failed", content: `Browser call not connected: ${reason.slice(0, 120)}` } });
  return { ok: true };
}
