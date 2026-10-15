import "server-only";
import { Types, type ClientSession } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Cleaner } from "@/lib/db/models/cleaner";
import { Notification, type NotificationDoc, type NotificationType } from "@/lib/db/models/notification";
import { formatDateTime } from "@/lib/domain/time";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { Errors } from "@/lib/http/errors";

const TITLES: Record<NotificationType, string> = {
  assignment_added: "New job assigned to you",
  assignment_removed: "You were removed from a job",
  booking_rescheduled: "Job time changed",
  booking_cancelled: "Job cancelled",
};

export type BookingNotice = {
  organizationId: Types.ObjectId;
  bookingId: Types.ObjectId;
  reference: string;
  start: Date;
  timezone: string;
  city: string;
  /** Unique per change (e.g. booking version), so retries don't notify twice. */
  changeKey: string;
};

/**
 * Notifies the signed-in users linked to the given cleaner records. Only
 * cleaners who are (or were just) assigned are passed in, so recipients are
 * limited to people entitled to the job. Runs inside the booking transaction.
 */
export async function notifyCleaners(session: ClientSession | null, type: NotificationType, cleanerIds: Types.ObjectId[], n: BookingNotice) {
  if (!cleanerIds.length) return;
  const cleaners = await Cleaner.find({ _id: { $in: cleanerIds }, organizationId: n.organizationId, linkedUserId: { $ne: null } }).select("linkedUserId").session(session).lean();
  if (!cleaners.length) return;
  const when = formatDateTime(n.start, n.timezone);
  const body = `${n.reference} · ${when}${n.city ? ` · ${n.city}` : ""}`;
  const docs = cleaners.map((c) => ({
    organizationId: n.organizationId,
    userId: c.linkedUserId,
    type,
    bookingId: n.bookingId,
    title: TITLES[type],
    body,
    dedupeKey: `${type}:${n.bookingId}:${n.changeKey}:${c.linkedUserId}`,
  }));
  try {
    await Notification.insertMany(docs, { session: session ?? undefined, ordered: false });
  } catch (err) {
    // Duplicate keys (retried transaction) are fine; anything else is not.
    const e = err as { code?: number; writeErrors?: { code?: number }[] };
    if (!(e.code === 11000 || e.writeErrors?.every((w) => w.code === 11000))) throw err;
  }
}

export type NotificationItem = { id: string; type: NotificationType; title: string; body: string; href: string | null; read: boolean; createdAt: string };

function toItem(n: NotificationDoc): NotificationItem {
  return { id: String(n._id), type: n.type as NotificationType, title: n.title, body: n.body ?? "", href: n.bookingId ? `/dashboard/bookings/${n.bookingId}` : null, read: Boolean(n.readAt), createdAt: n.createdAt.toISOString() };
}

export async function unreadCount(user: CurrentUser): Promise<number> {
  await connectDb();
  return Notification.countDocuments({ organizationId: user.organizationId, userId: user.id, readAt: null });
}

export async function listNotifications(user: CurrentUser, page = 1) {
  await connectDb();
  const filter = { organizationId: new Types.ObjectId(user.organizationId), userId: new Types.ObjectId(user.id) };
  const [total, rows, unread] = await Promise.all([
    Notification.countDocuments(filter),
    Notification.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * 30).limit(30).lean(),
    Notification.countDocuments({ ...filter, readAt: null }),
  ]);
  return { items: (rows as NotificationDoc[]).map(toItem), unread, page, totalPages: Math.max(1, Math.ceil(total / 30)) };
}

export const markReadSchema = z.union([z.object({ all: z.literal(true) }).strict(), z.object({ ids: z.array(z.string().regex(OBJECT_ID_RE)).min(1).max(100) }).strict()]);

/** Marks the caller's own notifications read (never anyone else's). */
export async function markRead(user: CurrentUser, raw: unknown) {
  const input = markReadSchema.parse(raw);
  await connectDb();
  const filter: Record<string, unknown> = { organizationId: user.organizationId, userId: user.id, readAt: null };
  if ("ids" in input) filter._id = { $in: input.ids.map((i) => new Types.ObjectId(i)) };
  const res = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
  if (!res) throw Errors.notFound("Notification");
  return { updated: res.modifiedCount };
}
