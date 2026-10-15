import "server-only";
import { hostname } from "node:os";
import { Types, type ClientSession } from "mongoose";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { OutboxMessage, type OutboxDoc, type OutboxStatus } from "@/lib/db/models/outbox-message";
import { WorkerHeartbeat } from "@/lib/db/models/worker-heartbeat";
import { EmailDeliveryError, sendEmail, type OutgoingEmail } from "@/lib/email/mailer";
import { ConfigError } from "@/lib/env";
import { Errors } from "@/lib/http/errors";
import { logger } from "@/lib/logger";
import { maskEmail } from "@/lib/security/redact";

/** Backoff after each failed attempt: 1 min, 5 min, 15 min, 1 h, 3 h, then "failed". */
export const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000];
const LOCK_MS = 2 * 60_000;
const PERMANENT = new Set(["SMTP_REJECTED_RECIPIENT", "SMTP_REJECTED"]);

export type EnqueueInput = {
  organizationId: Types.ObjectId | string;
  kind: OutboxDoc["kind"];
  message: OutgoingEmail;
  dedupeKey: string;
  relatedType?: "booking" | "user";
  relatedId?: Types.ObjectId | string | null;
  createdBy?: Types.ObjectId | string | null;
};

/** Queues an email once per dedupeKey. Returns the existing message on replays. */
export async function enqueueEmail(input: EnqueueInput, session?: ClientSession): Promise<{ id: string; created: boolean }> {
  const subject = input.message.subject.replace(/[\r\n]+/g, " ").slice(0, 300);
  try {
    const [doc] = await OutboxMessage.create(
      [
        {
          organizationId: input.organizationId,
          kind: input.kind,
          to: input.message.to,
          subject,
          html: input.message.html,
          text: input.message.text,
          dedupeKey: input.dedupeKey,
          relatedType: input.relatedType ?? null,
          relatedId: input.relatedId ?? null,
          createdBy: input.createdBy ?? null,
        },
      ],
      { session },
    );
    return { id: String(doc!._id), created: true };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const existing = await OutboxMessage.findOne({ organizationId: input.organizationId, dedupeKey: input.dedupeKey }).select("_id").session(session ?? null).lean();
      if (existing) return { id: String(existing._id), created: false };
    }
    throw err;
  }
}

/** Claims one due message (or one whose worker died mid-send). */
async function claim(now: Date) {
  return OutboxMessage.findOneAndUpdate(
    {
      $or: [
        { status: "pending", nextAttemptAt: { $lte: now } },
        { status: "sending", lockedUntil: { $lt: now } },
      ],
    },
    { $set: { status: "sending", lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, returnDocument: "after" },
  ).lean();
}

/**
 * Delivers up to `limit` due messages. Safe to run from several workers at once
 * (each message is claimed atomically). Returns counts for monitoring.
 */
export async function processOutboxBatch(limit = 20, now = () => new Date(), send: (m: OutgoingEmail) => Promise<{ messageId: string }> = sendEmail) {
  await connectDb();
  const result = { sent: 0, retried: 0, failed: 0 };
  for (let i = 0; i < limit; i++) {
    const msg = await claim(now());
    if (!msg) break;
    try {
      const info = await send({ to: msg.to, subject: msg.subject, html: msg.html, text: msg.text });
      await OutboxMessage.updateOne({ _id: msg._id, status: "sending" }, { $set: { status: "sent", sentAt: now(), providerMessageId: info.messageId.slice(0, 300), lockedUntil: null, lastError: null } });
      result.sent++;
    } catch (err) {
      const code = err instanceof EmailDeliveryError ? err.code : err instanceof ConfigError ? "SMTP_NOT_CONFIGURED" : "UNKNOWN";
      const final = PERMANENT.has(code) || msg.attempts >= msg.maxAttempts;
      const delay = BACKOFF_MS[Math.min(msg.attempts - 1, BACKOFF_MS.length - 1)]!;
      await OutboxMessage.updateOne(
        { _id: msg._id, status: "sending" },
        { $set: { status: final ? "failed" : "pending", lastError: code, lockedUntil: null, nextAttemptAt: new Date(now().getTime() + delay) } },
      );
      logger.warn("outbox.delivery_failed", { messageId: String(msg._id), kind: msg.kind, to: maskEmail(msg.to), code, attempt: msg.attempts, final });
      if (final) result.failed++;
      else result.retried++;
    }
  }
  return result;
}

export async function recordHeartbeat(worker: string, lastResult: unknown) {
  await WorkerHeartbeat.updateOne({ _id: worker }, { $set: { host: hostname().slice(0, 200), beatAt: new Date(), lastRunAt: new Date(), lastResult } }, { upsert: true });
}

// ---------------------------------------------------------------------------
// Administration (system:diagnostics)
// ---------------------------------------------------------------------------

export type OutboxItem = { id: string; kind: string; to: string; subject: string; status: OutboxStatus; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null; nextAttemptAt: string; relatedType: string | null; relatedId: string | null };

function toItem(m: OutboxDoc, maskRecipient: boolean): OutboxItem {
  return {
    id: String(m._id),
    kind: m.kind,
    to: maskRecipient ? maskEmail(m.to) : m.to,
    subject: m.subject,
    status: m.status as OutboxStatus,
    attempts: m.attempts,
    lastError: m.lastError ?? null,
    createdAt: m.createdAt.toISOString(),
    sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    nextAttemptAt: m.nextAttemptAt.toISOString(),
    relatedType: m.relatedType ?? null,
    relatedId: m.relatedId ? String(m.relatedId) : null,
  };
}

export async function outboxOverview(user: CurrentUser) {
  if (!user.permissions.has("system:diagnostics")) throw Errors.forbidden();
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  const [counts, recent, heartbeat] = await Promise.all([
    OutboxMessage.aggregate<{ _id: string; n: number }>([{ $match: { organizationId: orgId } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    OutboxMessage.find({ organizationId: orgId, status: { $in: ["failed", "pending", "sending"] } }).sort({ createdAt: -1 }).limit(50).lean(),
    WorkerHeartbeat.findById("outbox").lean(),
  ]);
  return {
    counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) as Partial<Record<OutboxStatus, number>>,
    attention: (recent as OutboxDoc[]).map((m) => toItem(m, true)),
    worker: heartbeat ? { beatAt: heartbeat.beatAt.toISOString(), host: heartbeat.host, lastResult: heartbeat.lastResult } : null,
  };
}

/** Puts a failed message back in the queue (next worker run). */
export async function retryOutboxMessage(user: CurrentUser, id: string) {
  if (!user.permissions.has("system:diagnostics")) throw Errors.forbidden();
  await connectDb();
  if (!Types.ObjectId.isValid(id)) throw Errors.notFound("Message");
  const res = await OutboxMessage.updateOne(
    { _id: id, organizationId: user.organizationId, status: "failed" },
    { $set: { status: "pending", nextAttemptAt: new Date(), lastError: null }, $inc: { maxAttempts: 1 } },
  );
  if (res.matchedCount === 0) throw Errors.conflict("NOT_FAILED", "Only failed messages can be retried.");
  return { ok: true };
}

/** Email history for one booking (office users with bookings:read). */
export async function bookingEmails(user: CurrentUser, bookingId: string): Promise<OutboxItem[]> {
  if (!user.permissions.has("bookings:read")) throw Errors.forbidden();
  await connectDb();
  const rows = await OutboxMessage.find({ organizationId: user.organizationId, relatedType: "booking", relatedId: bookingId }).sort({ createdAt: -1 }).limit(20).lean();
  return (rows as OutboxDoc[]).map((m) => toItem(m, false));
}
