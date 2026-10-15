import "server-only";
import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Attachment, ATTACHMENT_CATEGORIES, type AttachmentCategory, type AttachmentDoc } from "@/lib/db/models/attachment";
import { Booking } from "@/lib/db/models/booking";
import { ServiceAddress } from "@/lib/db/models/service-address";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { AppError, Errors } from "@/lib/http/errors";
import { logger } from "@/lib/logger";
import { enforce, RATE_LIMITS } from "@/lib/security/rate-limit";
import { storage } from "@/lib/storage";
import { recordAudit } from "@/modules/audit/service";
import { viewerFor } from "@/modules/bookings/service";

/** Allowed types, verified by file signature on completion (never by extension alone). SVG/HTML/executables are refused. */
export const ALLOWED_TYPES: Record<string, { maxBytes: number; image: boolean; ext: string }> = {
  "image/jpeg": { maxBytes: 15 * 1024 * 1024, image: true, ext: "jpg" },
  "image/png": { maxBytes: 15 * 1024 * 1024, image: true, ext: "png" },
  "image/webp": { maxBytes: 15 * 1024 * 1024, image: true, ext: "webp" },
  "application/pdf": { maxBytes: 20 * 1024 * 1024, image: false, ext: "pdf" },
};
const UPLOAD_URL_TTL = 300;
const THUMB_WIDTH = 480;

export function sniffType(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (head.length >= 5 && head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

/** Keeps a readable, harmless display name (no paths, control or quote characters). */
export function safeFileName(name: string, ext: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/\.[^.]*$/, "").normalize("NFKC").replace(/[^\p{L}\p{N} ._()-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${cleaned || "file"}.${ext}`;
}

const parentSchema = { parentType: z.enum(["address", "booking"]), parentId: z.string().regex(OBJECT_ID_RE) };
export const initiateSchema = z
  .object({ ...parentSchema, category: z.enum(ATTACHMENT_CATEGORIES), fileName: z.string().trim().min(1).max(255), contentType: z.string().max(100), size: z.number().int().min(1) })
  .strict();
export const listSchema = z.object({ ...parentSchema, includeProperty: z.enum(["1"]).optional() });

type Access = { customerId: Types.ObjectId; office: boolean };

/**
 * Resolves the parent record inside the user's organization and checks the
 * caller may read or write its files. Cleaners only reach jobs they are
 * assigned to (and that job's property photos).
 */
async function access(user: CurrentUser, parentType: "address" | "booking", parentId: string, mode: "read" | "write", category?: AttachmentCategory): Promise<Access> {
  if (!OBJECT_ID_RE.test(parentId)) throw Errors.notFound("Record");
  const orgId = new Types.ObjectId(user.organizationId);
  const office = user.permissions.has(mode === "read" ? "attachments:read" : "attachments:write");
  if (office) {
    if (parentType === "address") {
      if (!user.permissions.has("customers:read")) throw Errors.forbidden();
      const a = await ServiceAddress.findOne({ _id: parentId, organizationId: orgId }).select("customerId").lean();
      if (!a) throw Errors.notFound("Address");
      if (category && category !== "property_photo" && category !== "document") throw Errors.validation("Choose a property photo or document for an address.");
      return { customerId: a.customerId, office: true };
    }
    if (!user.permissions.has("bookings:read")) throw Errors.forbidden();
    const b = await Booking.findOne({ _id: parentId, organizationId: orgId }).select("customerId").lean();
    if (!b) throw Errors.notFound("Booking");
    return { customerId: b.customerId, office: true };
  }
  if (!user.permissions.has("attachments:assigned")) throw Errors.forbidden();
  const viewer = await viewerFor(user);
  if (!viewer.cleanerId) throw Errors.forbidden();
  if (parentType === "booking") {
    const b = await Booking.findOne({ _id: parentId, organizationId: orgId, assignedCleanerIds: viewer.cleanerId }).select("customerId status").lean();
    if (!b) throw Errors.notFound("Booking");
    if (mode === "write" && (b.status === "CANCELLED" || (category !== "before_photo" && category !== "after_photo"))) throw Errors.forbidden("Cleaners can add before/after photos to their active jobs.");
    return { customerId: b.customerId, office: false };
  }
  if (mode === "write") throw Errors.forbidden();
  const b = await Booking.findOne({ organizationId: orgId, serviceAddressId: parentId, assignedCleanerIds: viewer.cleanerId, status: { $ne: "CANCELLED" } }).select("customerId").lean();
  if (!b) throw Errors.notFound("Address");
  return { customerId: b.customerId, office: false };
}

/** Step 1: validates the request and returns a short-lived upload URL for a random key. */
export async function initiateUpload(user: CurrentUser, raw: unknown) {
  const input = initiateSchema.parse(raw);
  const type = ALLOWED_TYPES[input.contentType];
  if (!type) throw Errors.validation("Upload a JPEG, PNG or WebP photo, or a PDF document.");
  if (input.size > type.maxBytes) throw Errors.validation(`The file is too large (maximum ${Math.round(type.maxBytes / 1024 / 1024)} MB).`);
  if (type.image !== (input.category !== "document")) throw Errors.validation(input.category === "document" ? "Documents must be PDF files." : "Photos must be JPEG, PNG or WebP images.");
  await connectDb();
  await enforce([[RATE_LIMITS.uploadByUser, user.id]]);
  const a = await access(user, input.parentType, input.parentId, "write", input.category);
  const id = new Types.ObjectId();
  const key = `org/${user.organizationId}/${input.parentType}/${input.parentId}/${id}-${randomBytes(8).toString("hex")}`;
  const signed = await storage().presignPut(key, input.contentType, input.size, UPLOAD_URL_TTL);
  await Attachment.create({
    _id: id,
    organizationId: user.organizationId,
    parentType: input.parentType,
    parentId: input.parentId,
    customerId: a.customerId,
    category: input.category,
    fileName: safeFileName(input.fileName, type.ext),
    mimeType: input.contentType,
    size: input.size,
    storageKey: key,
    visibility: input.category === "document" ? "office" : "assigned_cleaners",
    uploadedBy: user.id,
  });
  return { attachmentId: String(id), uploadUrl: signed.url, headers: signed.headers, expiresInSeconds: UPLOAD_URL_TTL };
}

/**
 * Step 2: verifies the stored object before attaching it — it must exist,
 * match the declared size, carry the declared file signature, and (images)
 * decode cleanly. A thumbnail is generated for images. Failures delete the object.
 */
export async function completeUpload(user: CurrentUser, id: string) {
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("File");
  await connectDb();
  const att = (await Attachment.findOne({ _id: id, organizationId: user.organizationId, uploadedBy: user.id }).lean()) as AttachmentDoc | null;
  if (!att) throw Errors.notFound("File");
  if (att.status === "ready") return toItem(att, user);
  if (att.status !== "pending") throw Errors.notFound("File");
  const store = storage();
  const reject = async (message: string) => {
    await store.remove(att.storageKey).catch(() => undefined);
    await Attachment.updateOne({ _id: att._id }, { $set: { status: "deleted", deletedAt: new Date() } });
    throw new AppError(422, "UPLOAD_REJECTED", message);
  };
  const head = await store.head(att.storageKey);
  if (!head) throw new AppError(409, "UPLOAD_MISSING", "The file hasn't finished uploading. Try again.");
  const type = ALLOWED_TYPES[att.mimeType]!;
  if (head.size !== att.size || head.size > type.maxBytes) return reject("The uploaded file doesn't match what was announced.");
  const bytes = await store.getBytes(att.storageKey, type.image ? type.maxBytes : 64);
  if (sniffType(bytes.subarray(0, 64)) !== att.mimeType) return reject("The file content doesn't match its type. Only real JPEG, PNG, WebP or PDF files are accepted.");
  const set: Record<string, unknown> = { status: "ready", readyAt: new Date() };
  if (type.image) {
    try {
      const sharp = (await import("sharp")).default;
      const img = sharp(bytes, { limitInputPixels: 50_000_000, failOn: "error" }).rotate();
      const meta = await img.metadata();
      const thumb = await img.resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
      const swap = (meta.orientation ?? 1) >= 5;
      set.width = swap ? meta.height : meta.width;
      set.height = swap ? meta.width : meta.height;
      set.thumbKey = `${att.storageKey}.thumb`;
      await store.put(set.thumbKey as string, thumb, "image/webp");
    } catch (err) {
      logger.warn("attachment.image_rejected", { id, error: err instanceof Error ? err.message : String(err) });
      return reject("The image couldn't be read. Try exporting it again as JPEG or PNG.");
    }
  }
  await Attachment.updateOne({ _id: att._id, status: "pending" }, { $set: set });
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "attachment.added", entityType: att.parentType, entityId: att.parentId, metadata: { category: att.category, size: att.size } });
  return toItem({ ...att, ...set } as AttachmentDoc, user);
}

export type AttachmentItem = { id: string; category: AttachmentCategory; fileName: string; mimeType: string; size: number; width: number | null; height: number | null; hasThumb: boolean; createdAt: string; canDelete: boolean; url: string; thumbUrl: string | null };

function toItem(a: AttachmentDoc, user: CurrentUser): AttachmentItem {
  const id = String(a._id);
  return {
    id,
    category: a.category as AttachmentCategory,
    fileName: a.fileName,
    mimeType: a.mimeType,
    size: a.size,
    width: a.width ?? null,
    height: a.height ?? null,
    hasThumb: Boolean(a.thumbKey),
    createdAt: a.createdAt.toISOString(),
    canDelete: user.permissions.has("attachments:delete") || String(a.uploadedBy) === user.id,
    url: `/api/v1/attachments/${id}/content`,
    thumbUrl: a.thumbKey ? `/api/v1/attachments/${id}/content?variant=thumb` : null,
  };
}

export async function listAttachments(user: CurrentUser, raw: unknown): Promise<AttachmentItem[]> {
  const input = listSchema.parse(raw);
  await connectDb();
  const a = await access(user, input.parentType, input.parentId, "read");
  const filter: Record<string, unknown> = { organizationId: user.organizationId, parentType: input.parentType, parentId: new Types.ObjectId(input.parentId), status: "ready" };
  if (!a.office) filter.visibility = "assigned_cleaners";
  const rows = (await Attachment.find(filter).sort({ createdAt: -1 }).limit(200).lean()) as AttachmentDoc[];
  if (input.parentType === "booking" && input.includeProperty) {
    // The job's property photos (read through the address's own access rules when opened).
    const b = await Booking.findOne({ _id: input.parentId, organizationId: user.organizationId }).select("serviceAddressId").lean();
    if (b?.serviceAddressId) {
      const prop = (await Attachment.find({ organizationId: user.organizationId, parentType: "address", parentId: b.serviceAddressId, status: "ready", category: "property_photo", ...(a.office ? {} : { visibility: "assigned_cleaners" }) }).sort({ createdAt: -1 }).limit(50).lean()) as AttachmentDoc[];
      rows.push(...prop.map((p) => ({ ...p, uploadedBy: a.office ? p.uploadedBy : new Types.ObjectId() }) as AttachmentDoc));
    }
  }
  return rows.map((r) => toItem(r, user));
}

/** Authorized read: the record is re-checked on every request; storage keys are never exposed. */
export async function openAttachment(user: CurrentUser, id: string, variant: "original" | "thumb") {
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("File");
  await connectDb();
  const att = (await Attachment.findOne({ _id: id, organizationId: user.organizationId, status: "ready" }).lean()) as AttachmentDoc | null;
  if (!att) throw Errors.notFound("File");
  const a = await access(user, att.parentType as "address" | "booking", String(att.parentId), "read");
  if (!a.office && att.visibility !== "assigned_cleaners") throw Errors.notFound("File");
  const key = variant === "thumb" && att.thumbKey ? att.thumbKey : att.storageKey;
  const { body, size } = await storage().getStream(key);
  return { body, size, mimeType: variant === "thumb" && att.thumbKey ? "image/webp" : att.mimeType, fileName: att.fileName, isImage: att.mimeType.startsWith("image/") };
}

export async function deleteAttachment(user: CurrentUser, id: string) {
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("File");
  await connectDb();
  const att = (await Attachment.findOne({ _id: id, organizationId: user.organizationId, status: "ready" }).lean()) as AttachmentDoc | null;
  if (!att) throw Errors.notFound("File");
  await access(user, att.parentType as "address" | "booking", String(att.parentId), "read");
  const own = String(att.uploadedBy) === user.id;
  if (!own && !user.permissions.has("attachments:delete")) throw Errors.forbidden("You can remove files you uploaded.");
  await Attachment.updateOne({ _id: att._id, status: "ready" }, { $set: { status: "deleted", deletedAt: new Date(), deletedBy: user.id } });
  const store = storage();
  await store.remove(att.storageKey).catch((err) => logger.warn("attachment.remove_failed", { id, error: String(err) }));
  if (att.thumbKey) await store.remove(att.thumbKey).catch(() => undefined);
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "attachment.removed", entityType: att.parentType, entityId: att.parentId, metadata: { category: att.category, fileName: att.fileName } });
  return { ok: true };
}

/** Worker: abandons uploads never completed within a day (deletes stray objects). */
export async function cleanupStaleUploads(olderThanMs = 24 * 3600 * 1000) {
  await connectDb();
  const stale = await Attachment.find({ status: "pending", createdAt: { $lt: new Date(Date.now() - olderThanMs) } }).limit(100).lean();
  for (const s of stale) {
    try {
      await storage().remove(s.storageKey);
    } catch {
      /* object may not exist */
    }
    await Attachment.updateOne({ _id: s._id, status: "pending" }, { $set: { status: "deleted", deletedAt: new Date() } });
  }
  return stale.length;
}
