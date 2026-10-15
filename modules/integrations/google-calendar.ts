import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Booking } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Customer } from "@/lib/db/models/customer";
import { CalendarSync, GoogleCalendarConnection, OAuthState, type CalendarSyncDoc, type GoogleConnectionDoc } from "@/lib/db/models/google-calendar";
import { Organization } from "@/lib/db/models/organization";
import { BOOKING_STATUS_LABELS, type BookingStatus } from "@/lib/domain/constants";
import { formatAddress } from "@/lib/domain/links";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { getCoreEnv, getGoogleEnv, type GoogleEnv } from "@/lib/env";
import { AppError, Errors } from "@/lib/http/errors";
import { authorizationUrl, calendarApi, emailFromIdToken, eventIdForBooking, exchangeCode, GoogleApiError, pkcePair, refreshAccessToken, revokeToken, type GoogleEvent } from "@/lib/integrations/google";
import { logger } from "@/lib/logger";
import { decryptSecret, encryptSecret } from "@/lib/security/encryption";
import { recordAudit } from "@/modules/audit/service";

/**
 * Google Calendar — OUTBOUND sync only (RealtyPacer → Google).
 * The CRM is the source of truth. External edits are detected by a periodic
 * check (worker, hourly) and reported, never imported; Google events never
 * become customers, jobs or leads. No guests are added, so Google sends no
 * invitations.
 */

export const CALLBACK_PATH = "/api/v1/integrations/google/callback";
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 3600_000];
const MAX_ATTEMPTS = 6;
const LOCK_MS = 2 * 60_000;

function assertManager(user: CurrentUser) {
  if (!user.permissions.has("integrations:manage")) throw Errors.forbidden();
}

function requireGoogle(): GoogleEnv {
  const env = getGoogleEnv();
  if (!env) throw new AppError(503, "GOOGLE_NOT_CONFIGURED", "Google Calendar isn't configured on the server yet (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY).");
  return env;
}

const hash = (s: string) => createHash("sha256").update(s).digest("base64url");
const redirectUri = () => `${getCoreEnv().APP_URL}${CALLBACK_PATH}`;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Step 1: returns Google's consent URL; state and PKCE verifier are stored for 10 minutes. */
export async function startGoogleConnect(user: CurrentUser) {
  assertManager(user);
  const env = requireGoogle();
  await connectDb();
  const state = randomBytes(32).toString("base64url");
  const { verifier, challenge } = pkcePair();
  await OAuthState.create({ stateHash: hash(state), organizationId: user.organizationId, userId: user.id, codeVerifierEnc: encryptSecret(verifier, env.TOKEN_ENCRYPTION_KEY), expiresAt: new Date(Date.now() + 10 * 60_000) });
  return { url: authorizationUrl({ clientId: env.GOOGLE_CLIENT_ID, redirectUri: redirectUri(), state, codeChallenge: challenge, loginHint: user.email }) };
}

/** Step 2 (callback): single-use state bound to the same signed-in user; tokens encrypted at rest. */
export async function completeGoogleConnect(user: CurrentUser, code: string, state: string) {
  assertManager(user);
  const env = requireGoogle();
  await connectDb();
  const st = await OAuthState.findOneAndDelete({ stateHash: hash(state), userId: user.id, organizationId: user.organizationId, expiresAt: { $gt: new Date() } }).lean();
  if (!st) throw new AppError(400, "OAUTH_STATE_INVALID", "The Google sign-in expired or didn't start here. Please try connecting again.");
  const tokens = await exchangeCode({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, code, redirectUri: redirectUri(), codeVerifier: decryptSecret(st.codeVerifierEnc, env.TOKEN_ENCRYPTION_KEY) });
  if (!tokens.scope.includes("calendar.events")) throw new AppError(400, "SCOPE_DENIED", "Calendar access wasn't granted. Connect again and allow access to calendar events.");
  const existing = await GoogleCalendarConnection.findOne({ organizationId: user.organizationId }).lean();
  const refresh = tokens.refreshToken ? encryptSecret(tokens.refreshToken, env.TOKEN_ENCRYPTION_KEY) : existing?.refreshTokenEnc;
  if (!refresh) throw new AppError(400, "NO_REFRESH_TOKEN", "Google didn't return offline access. Remove RealtyPacer from your Google account's third-party access, then connect again.");
  await GoogleCalendarConnection.updateOne(
    { organizationId: user.organizationId },
    {
      $set: {
        connectedBy: user.id,
        googleEmail: emailFromIdToken(tokens.idToken),
        refreshTokenEnc: refresh,
        accessTokenEnc: encryptSecret(tokens.accessToken, env.TOKEN_ENCRYPTION_KEY),
        accessTokenExpiresAt: new Date(Date.now() + (tokens.expiresIn - 60) * 1000),
        scopes: tokens.scope.split(" "),
        status: "connected",
        lastError: null,
        lastErrorAt: null,
      },
      $setOnInsert: { calendarId: "primary", calendarName: "Primary calendar" },
    },
    { upsert: true },
  );
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "integration.google_connected", entityType: "integration", entityId: user.organizationId });
  await queueUpcomingBookings(user.organizationId);
}

/** After connecting: add upcoming scheduled bookings (next 90 days) to the sync queue once. */
async function queueUpcomingBookings(orgId: Types.ObjectId | string) {
  const now = new Date();
  const upcoming = await Booking.find({ organizationId: orgId, status: { $in: ["SCHEDULED", "IN_PROGRESS"] }, scheduledStartAt: { $gte: now, $lt: new Date(now.getTime() + 90 * 86_400_000) } }).select("_id").limit(1000).lean();
  for (const b of upcoming) {
    await CalendarSync.updateOne({ organizationId: orgId, bookingId: b._id }, { $setOnInsert: { action: "upsert", status: "pending", nextAttemptAt: now, requestSeq: 1 } }, { upsert: true });
  }
}

async function markNeedsReauth(orgId: Types.ObjectId | string, message: string) {
  await GoogleCalendarConnection.updateOne({ organizationId: orgId }, { $set: { status: "needs_reauth", lastError: message.slice(0, 300), lastErrorAt: new Date() } });
}

/** A valid access token, refreshed when it is about to expire. */
async function accessToken(conn: GoogleConnectionDoc, env: GoogleEnv): Promise<string> {
  if (conn.accessTokenEnc && conn.accessTokenExpiresAt && conn.accessTokenExpiresAt.getTime() > Date.now() + 30_000) return decryptSecret(conn.accessTokenEnc, env.TOKEN_ENCRYPTION_KEY);
  if (!conn.refreshTokenEnc) throw new GoogleApiError(401, "invalid_grant", "No refresh token stored.");
  try {
    const t = await refreshAccessToken({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: decryptSecret(conn.refreshTokenEnc, env.TOKEN_ENCRYPTION_KEY) });
    await GoogleCalendarConnection.updateOne({ _id: conn._id }, { $set: { accessTokenEnc: encryptSecret(t.accessToken, env.TOKEN_ENCRYPTION_KEY), accessTokenExpiresAt: new Date(Date.now() + (t.expiresIn - 60) * 1000) } });
    return t.accessToken;
  } catch (err) {
    if (err instanceof GoogleApiError && err.needsReauth) await markNeedsReauth(conn.organizationId, "Google access was revoked or expired. Reconnect Google Calendar.");
    throw err;
  }
}

async function liveConnection(orgId: Types.ObjectId | string) {
  return (await GoogleCalendarConnection.findOne({ organizationId: orgId, status: "connected" }).lean()) as GoogleConnectionDoc | null;
}

export async function googleStatus(user: CurrentUser) {
  assertManager(user);
  await connectDb();
  let configured = false;
  let configIssue: string | null = null;
  try {
    configured = Boolean(getGoogleEnv());
  } catch (err) {
    configIssue = err instanceof Error ? err.message : "Invalid configuration";
  }
  const conn = (await GoogleCalendarConnection.findOne({ organizationId: user.organizationId }).lean()) as GoogleConnectionDoc | null;
  const orgId = new Types.ObjectId(user.organizationId);
  const [counts, problems] = await Promise.all([
    CalendarSync.aggregate<{ _id: string; n: number }>([{ $match: { organizationId: orgId } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    CalendarSync.find({ organizationId: orgId, $or: [{ status: "failed" }, { externalState: { $in: ["changed_in_google", "deleted_in_google"] } }] }).sort({ updatedAt: -1 }).limit(20).lean(),
  ]);
  const bookingRefs = new Map((await Booking.find({ _id: { $in: problems.map((p) => p.bookingId) }, organizationId: orgId }).select("reference").lean()).map((b) => [String(b._id), b.reference]));
  return {
    configured,
    configIssue,
    redirectUri: configured ? redirectUri() : null,
    connection: conn && conn.status !== "disconnected"
      ? { status: conn.status, googleEmail: conn.googleEmail, calendarId: conn.calendarId ?? null, calendarName: conn.calendarName ?? null, lastSyncAt: conn.lastSyncAt?.toISOString() ?? null, lastError: conn.lastError ?? null, lastErrorAt: conn.lastErrorAt?.toISOString() ?? null, lastVerifiedAt: conn.lastVerifiedAt?.toISOString() ?? null }
      : null,
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) as Record<string, number>,
    problems: (problems as CalendarSyncDoc[]).map((p) => ({ id: String(p._id), bookingId: String(p.bookingId), reference: bookingRefs.get(String(p.bookingId)) ?? "—", status: p.status, externalState: p.externalState ?? null, lastError: p.lastError ?? null, attempts: p.attempts, updatedAt: p.updatedAt.toISOString() })),
  };
}

export async function listGoogleCalendars(user: CurrentUser) {
  assertManager(user);
  const env = requireGoogle();
  await connectDb();
  const conn = await liveConnection(user.organizationId);
  if (!conn) throw new AppError(409, "GOOGLE_NOT_CONNECTED", "Connect Google Calendar first.");
  const res = await calendarApi.listCalendars(await accessToken(conn, env));
  return (res.items ?? []).filter((c) => c.accessRole === "owner" || c.accessRole === "writer").map((c) => ({ id: c.id, name: c.summary, primary: Boolean(c.primary) }));
}

export const selectCalendarSchema = z.object({ calendarId: z.string().min(1).max(300) }).strict();

/** Choose the calendar for booking events. Existing events move on their next sync (old copy deleted). */
export async function selectGoogleCalendar(user: CurrentUser, raw: unknown) {
  const { calendarId } = selectCalendarSchema.parse(raw);
  const calendars = await listGoogleCalendars(user);
  const cal = calendars.find((c) => c.id === calendarId);
  if (!cal) throw Errors.validation("Choose one of your calendars you can edit.");
  await GoogleCalendarConnection.updateOne({ organizationId: user.organizationId }, { $set: { calendarId: cal.id, calendarName: cal.name } });
  // Re-place upcoming linked events in the newly selected calendar.
  await CalendarSync.updateMany({ organizationId: user.organizationId, status: { $in: ["synced", "failed"] }, action: "upsert", calendarId: { $ne: cal.id } }, { $set: { status: "pending", nextAttemptAt: new Date(), attempts: 0 }, $inc: { requestSeq: 1 } });
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "integration.google_calendar_selected", entityType: "integration", entityId: user.organizationId });
  return { ok: true };
}

/** Revokes Google access and deletes stored tokens. Existing Google events are left as they are. */
export async function disconnectGoogle(user: CurrentUser) {
  assertManager(user);
  await connectDb();
  const conn = (await GoogleCalendarConnection.findOne({ organizationId: user.organizationId }).lean()) as GoogleConnectionDoc | null;
  if (!conn) return { ok: true };
  const env = getGoogleEnv();
  if (env && conn.refreshTokenEnc) {
    try {
      await revokeToken(decryptSecret(conn.refreshTokenEnc, env.TOKEN_ENCRYPTION_KEY));
    } catch {
      /* local deletion still happens */
    }
  }
  await GoogleCalendarConnection.updateOne({ _id: conn._id }, { $set: { status: "disconnected", refreshTokenEnc: null, accessTokenEnc: null, accessTokenExpiresAt: null } });
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "integration.google_disconnected", entityType: "integration", entityId: user.organizationId });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sync queue
// ---------------------------------------------------------------------------

/**
 * Records that a booking's event must be created/updated (or removed).
 * Called after booking changes commit. Cheap no-op when Google isn't connected;
 * never throws into the booking flow.
 */
export async function queueCalendarSync(orgId: Types.ObjectId | string, bookingId: Types.ObjectId | string, action: "upsert" | "delete") {
  try {
    if (!(await GoogleCalendarConnection.exists({ organizationId: orgId, status: { $in: ["connected", "needs_reauth"] } }))) return;
    if (action === "delete" && !(await CalendarSync.exists({ organizationId: orgId, bookingId, eventId: { $ne: null } }))) return;
    await CalendarSync.updateOne(
      { organizationId: orgId, bookingId },
      { $set: { action, status: "pending", nextAttemptAt: new Date(), attempts: 0, lastError: null }, $inc: { requestSeq: 1 } },
      { upsert: true },
    );
  } catch (err) {
    logger.error("calendar.queue_failed", { bookingId: String(bookingId), error: err instanceof Error ? err : String(err) });
  }
}

function buildEvent(b: { _id: Types.ObjectId; reference: string; scheduledStartAt: Date; scheduledEndAt: Date; timezone: string; status: string; addressSnapshot: unknown; lineItems: { name: string; quantity: number }[] }, customerName: string, cleaners: string[], orgName: string) {
  const services = b.lineItems.map((l) => (l.quantity > 1 ? `${l.name} ×${l.quantity}` : l.name)).join(", ");
  const link = `${getCoreEnv().APP_URL}/dashboard/bookings/${b._id}`;
  return {
    summary: `${services} — ${customerName}`.slice(0, 250),
    location: formatAddress(b.addressSnapshot as never),
    description: [
      `Booking ${b.reference} (${BOOKING_STATUS_LABELS[b.status as BookingStatus] ?? b.status})`,
      `Services: ${services}`,
      `Cleaner: ${cleaners.length ? cleaners.join(", ") : "Unassigned"}`,
      `Open in RealtyPacer (sign-in required): ${link}`,
      "",
      `Managed by RealtyPacer for ${orgName}. Change the booking in RealtyPacer — edits made here are overwritten and are not imported.`,
    ].join("\n"),
    start: { dateTime: b.scheduledStartAt.toISOString(), timeZone: b.timezone },
    end: { dateTime: b.scheduledEndAt.toISOString(), timeZone: b.timezone },
    extendedProperties: { private: { rpBookingId: String(b._id) } },
    reminders: { useDefault: true },
    guestsCanInviteOthers: false,
  };
}

async function claimNext(now: Date) {
  return (await CalendarSync.findOneAndUpdate(
    { $or: [{ status: "pending", nextAttemptAt: { $lte: now } }, { status: "processing", lockedUntil: { $lt: now } }] },
    { $set: { status: "processing", lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
  ).lean()) as CalendarSyncDoc | null;
}

async function syncOne(job: CalendarSyncDoc, env: GoogleEnv): Promise<void> {
  const conn = await liveConnection(job.organizationId);
  if (!conn || !conn.calendarId) throw new AppError(409, "NOT_CONNECTED", "Google Calendar isn't connected.");
  const token = await accessToken(conn, env);
  const calendarId = conn.calendarId;
  const done = async (set: Record<string, unknown>) => {
    // Only mark done if no newer change was queued while this ran.
    const res = await CalendarSync.updateOne({ _id: job._id, requestSeq: job.requestSeq, status: "processing" }, { $set: { ...set, lockedUntil: null, lastError: null, lastSyncedAt: new Date(), attempts: 0 } });
    if (res.matchedCount === 0) await CalendarSync.updateOne({ _id: job._id, status: "processing" }, { $set: { status: "pending", lockedUntil: null, nextAttemptAt: new Date() } });
    await GoogleCalendarConnection.updateOne({ _id: conn._id }, { $set: { lastSyncAt: new Date() } });
  };

  const booking = await Booking.findOne({ _id: job.bookingId, organizationId: job.organizationId }).select("reference customerId scheduledStartAt scheduledEndAt timezone status addressSnapshot lineItems.name lineItems.quantity assignedCleanerIds").lean();
  const remove = job.action === "delete" || !booking || booking.status === "CANCELLED";
  if (remove) {
    if (job.eventId) {
      try {
        await calendarApi.deleteEvent(token, job.calendarId ?? calendarId, job.eventId);
      } catch (err) {
        if (!(err instanceof GoogleApiError && (err.status === 404 || err.status === 410))) throw err;
      }
    }
    return done({ status: "removed" });
  }
  // Calendar changed in settings: remove the copy from the previous calendar first.
  if (job.eventId && job.calendarId && job.calendarId !== calendarId) {
    try {
      await calendarApi.deleteEvent(token, job.calendarId, job.eventId);
    } catch (err) {
      if (!(err instanceof GoogleApiError && (err.status === 404 || err.status === 410))) throw err;
    }
  }
  const [customer, cleaners, org] = await Promise.all([
    Customer.findById(booking.customerId).select("name").lean(),
    Cleaner.find({ _id: { $in: booking.assignedCleanerIds }, organizationId: job.organizationId }).select("name").lean(),
    Organization.findById(job.organizationId).select("displayName").lean(),
  ]);
  const body = buildEvent(booking as never, customer?.name ?? "Customer", cleaners.map((c) => c.name), org?.displayName ?? "your organization");
  const eventId = eventIdForBooking(String(booking._id));
  const samePlace = job.eventId && job.calendarId === calendarId;
  let ev: GoogleEvent;
  if (samePlace) {
    try {
      ev = await calendarApi.patchEvent(token, calendarId, job.eventId!, { ...body, status: "confirmed" });
    } catch (err) {
      if (!(err instanceof GoogleApiError && (err.status === 404 || err.status === 410))) throw err;
      ev = await calendarApi.insertEvent(token, calendarId, { id: eventId, ...body });
    }
  } else {
    try {
      ev = await calendarApi.insertEvent(token, calendarId, { id: eventId, ...body });
    } catch (err) {
      // Already created by an earlier attempt (or deleted in Google): update/restore it instead of duplicating.
      if (!(err instanceof GoogleApiError && err.status === 409)) throw err;
      ev = await calendarApi.patchEvent(token, calendarId, eventId, { ...body, status: "confirmed" });
    }
  }
  return done({ status: "synced", eventId: ev.id ?? eventId, calendarId, externalState: "ok" });
}

/** Worker: processes due sync jobs with retries and backoff. Safe with several workers. */
export async function processCalendarSyncBatch(limit = 25, now = () => new Date()) {
  const env = getGoogleEnv();
  if (!env) return { synced: 0, retried: 0, failed: 0 };
  await connectDb();
  const out = { synced: 0, retried: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const job = await claimNext(now());
    if (!job) break;
    try {
      await syncOne(job, env);
      out.synced++;
    } catch (err) {
      const g = err instanceof GoogleApiError ? err : null;
      const reauth = g?.needsReauth || g?.status === 401 || (err instanceof AppError && err.code === "NOT_CONNECTED");
      const final = !reauth && (job.attempts >= MAX_ATTEMPTS || (g !== null && !g.retryable && g.status !== 409));
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      const delay = reauth ? 3600_000 : BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)]!;
      await CalendarSync.updateOne({ _id: job._id, status: "processing" }, { $set: { status: final ? "failed" : "pending", lastError: reauth ? "Waiting for Google Calendar to be reconnected." : message, lockedUntil: null, nextAttemptAt: new Date(now().getTime() + delay) } });
      await GoogleCalendarConnection.updateOne({ organizationId: job.organizationId }, { $set: { lastError: message, lastErrorAt: now() } });
      logger.warn("calendar.sync_failed", { bookingId: String(job.bookingId), status: g?.status, code: g?.code, attempt: job.attempts, final });
      if (final) out.failed++;
      else out.retried++;
    }
  }
  return out;
}

/** Manual retry of failed syncs (one booking or all). */
export async function retryCalendarSync(user: CurrentUser, raw: unknown) {
  assertManager(user);
  const { bookingId } = z.object({ bookingId: z.string().regex(OBJECT_ID_RE).optional() }).strict().parse(raw);
  await connectDb();
  const filter: Record<string, unknown> = { organizationId: user.organizationId, $or: [{ status: "failed" }, { externalState: { $in: ["changed_in_google", "deleted_in_google"] } }] };
  if (bookingId) filter.bookingId = new Types.ObjectId(bookingId);
  const res = await CalendarSync.updateMany(filter, { $set: { status: "pending", nextAttemptAt: new Date(), attempts: 0, externalState: null }, $inc: { requestSeq: 1 } });
  return { queued: res.modifiedCount };
}

/**
 * Documented refresh strategy for changes made in Google (instead of push
 * channels): the worker re-reads upcoming linked events hourly and flags
 * ones edited or deleted in Google. Nothing is imported into the CRM;
 * “Retry” re-applies the CRM version.
 */
export async function verifyLinkedEvents(now = new Date()) {
  const env = getGoogleEnv();
  if (!env) return { checked: 0, flagged: 0 };
  await connectDb();
  let checked = 0;
  let flagged = 0;
  for (const conn of (await GoogleCalendarConnection.find({ status: "connected" }).lean()) as GoogleConnectionDoc[]) {
    let token: string;
    try {
      token = await accessToken(conn, env);
    } catch {
      continue;
    }
    const upcoming = await Booking.find({ organizationId: conn.organizationId, status: { $in: ["SCHEDULED", "IN_PROGRESS"] }, scheduledStartAt: { $gte: now, $lt: new Date(now.getTime() + 30 * 86_400_000) } }).select("_id scheduledStartAt").limit(200).lean();
    const syncs = (await CalendarSync.find({ organizationId: conn.organizationId, bookingId: { $in: upcoming.map((b) => b._id) }, status: "synced" }).lean()) as CalendarSyncDoc[];
    const startOf = new Map(upcoming.map((b) => [String(b._id), b.scheduledStartAt.getTime()]));
    for (const s of syncs) {
      if (!s.eventId || !s.calendarId) continue;
      checked++;
      let state: "ok" | "changed_in_google" | "deleted_in_google" = "ok";
      try {
        const ev = await calendarApi.getEvent(token, s.calendarId, s.eventId);
        if (ev.status === "cancelled") state = "deleted_in_google";
        else if (ev.start?.dateTime && new Date(ev.start.dateTime).getTime() !== startOf.get(String(s.bookingId))) state = "changed_in_google";
      } catch (err) {
        if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) state = "deleted_in_google";
        else continue;
      }
      if (state !== "ok") flagged++;
      if (state !== s.externalState) await CalendarSync.updateOne({ _id: s._id, status: "synced" }, { $set: { externalState: state } });
    }
    await GoogleCalendarConnection.updateOne({ _id: conn._id }, { $set: { lastVerifiedAt: new Date() } });
  }
  return { checked, flagged };
}

/**
 * Busy periods in the connected calendar for a booking-time warning. Only
 * start/end are returned (never titles); RealtyPacer's own events are excluded.
 */
export async function googleBusy(user: CurrentUser, from: Date, to: Date) {
  if (!user.permissions.has("bookings:write")) throw Errors.forbidden();
  const env = getGoogleEnv();
  if (!env) return { connected: false, busy: [] as { start: string; end: string }[] };
  await connectDb();
  const conn = await liveConnection(user.organizationId);
  if (!conn?.calendarId) return { connected: false, busy: [] };
  try {
    const res = await calendarApi.listEvents(await accessToken(conn, env), conn.calendarId, from.toISOString(), to.toISOString());
    const busy = (res.items ?? [])
      .filter((e) => e.status !== "cancelled" && e.transparency !== "transparent" && e.start?.dateTime && e.end?.dateTime)
      // RealtyPacer's own bookings are already conflict-checked by the CRM.
      .filter((e) => !e.extendedProperties?.private?.rpBookingId)
      .map((e) => ({ start: e.start!.dateTime!, end: e.end!.dateTime! }));
    return { connected: true, busy };
  } catch (err) {
    logger.warn("calendar.busy_failed", { error: err instanceof Error ? err.message : String(err) });
    return { connected: true, busy: [], unavailable: true };
  }
}
