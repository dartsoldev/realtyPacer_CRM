import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Lead, LEAD_CATEGORIES, LeadSource, LeadSubmissionLog, RE_INTENTS, type LeadCategory } from "@/lib/db/models/lead";
import { getCoreEnv } from "@/lib/env";
import { isSafeHttpUrl } from "@/lib/domain/links";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { parsePhone } from "@/lib/domain/phone";
import { isDateKey } from "@/lib/domain/zoned-time";
import { AppError, Errors } from "@/lib/http/errors";
import { hit } from "@/lib/security/rate-limit";
import { recordAudit } from "@/modules/audit/service";
import { leadFields, leadInputSchema } from "./service";

/** Lead fields an incoming form field can be mapped to. */
export const INTAKE_TARGETS = [
  "name", "firstName", "lastName", "phone", "email", "city", "address", "notes",
  "requestedService", "preferredDate", "serviceLocation",
  "intent", "areaOfInterest", "budget", "listingUrl",
  "category", "externalId",
] as const;
export type IntakeTarget = (typeof INTAKE_TARGETS)[number];

/** Used when a field is not in the source's own mapping (keys compared without case/punctuation). */
const DEFAULT_SYNONYMS: Record<string, IntakeTarget> = {
  name: "name", fullname: "name", yourname: "name",
  firstname: "firstName", fname: "firstName", lastname: "lastName", lname: "lastName",
  phone: "phone", phonenumber: "phone", tel: "phone", mobile: "phone", yourphone: "phone",
  email: "email", emailaddress: "email", youremail: "email",
  city: "city", address: "address", streetaddress: "address",
  message: "notes", notes: "notes", comments: "notes", yourmessage: "notes",
  service: "requestedService", requestedservice: "requestedService",
  preferreddate: "preferredDate", date: "preferredDate",
  servicelocation: "serviceLocation", location: "serviceLocation",
  intent: "intent", lookingto: "intent", iama: "intent",
  area: "areaOfInterest", areaofinterest: "areaOfInterest", neighbourhood: "areaOfInterest", neighborhood: "areaOfInterest",
  budget: "budget", pricerange: "budget",
  listing: "listingUrl", listingurl: "listingUrl", propertyurl: "listingUrl",
  category: "category", leadtype: "category",
  submissionid: "externalId", entryid: "externalId", externalid: "externalId",
};

const keyOf = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const INTAKE_PATH = "/api/v1/intake/leads";
export const intakeUrl = (slug: string) => `${getCoreEnv().APP_URL}${INTAKE_PATH}/${slug}`;

// ---------------------------------------------------------------------------
// Source administration (owner/admin only)
// ---------------------------------------------------------------------------

function assertManage(user: CurrentUser) {
  if (!user.permissions.has("integrations:manage")) throw Errors.forbidden();
}

const fieldMapSchema = z
  .record(z.string().trim().min(1).max(100).regex(/^[\w\-\[\]. ]+$/, "Use letters, numbers, - _ . [ ]"), z.enum(INTAKE_TARGETS))
  .refine((m) => Object.keys(m).length <= 40, "Map at most 40 fields");

export const sourceCreateSchema = z.object({ name: z.string().trim().min(1, "Name is required").max(120), defaultCategory: z.enum(LEAD_CATEGORIES), fieldMap: fieldMapSchema.default({}) }).strict();
export const sourceUpdateSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), defaultCategory: z.enum(LEAD_CATEGORIES).optional(), fieldMap: fieldMapSchema.optional(), active: z.boolean().optional() }).strict();

function newSecret() {
  const secret = `rpk_${randomBytes(24).toString("base64url")}`;
  return { secret, secretHash: sha256(secret), secretHint: secret.slice(-4) };
}

function sourceDto(s: { _id: Types.ObjectId; name: string; slug: string; defaultCategory: string; fieldMap?: unknown; secretHint?: string | null; active?: boolean | null; lastReceivedAt?: Date | null; receivedCount?: number | null }) {
  return {
    id: String(s._id),
    name: s.name,
    slug: s.slug,
    endpoint: intakeUrl(s.slug),
    defaultCategory: s.defaultCategory as LeadCategory,
    fieldMap: (s.fieldMap ?? {}) as Record<string, IntakeTarget>,
    secretHint: s.secretHint ? `…${s.secretHint}` : "",
    active: s.active !== false,
    lastReceivedAt: s.lastReceivedAt?.toISOString() ?? null,
    receivedCount: s.receivedCount ?? 0,
  };
}
export type LeadSourceDto = ReturnType<typeof sourceDto>;

export async function listLeadSources(user: CurrentUser) {
  assertManage(user);
  await connectDb();
  const rows = await LeadSource.find({ organizationId: user.organizationId }).sort({ createdAt: 1 }).lean();
  return rows.map((r) => sourceDto(r as never));
}

/** Creates a source. The key is returned once and only its hash is stored. */
export async function createLeadSource(user: CurrentUser, raw: unknown) {
  assertManage(user);
  const input = sourceCreateSchema.parse(raw);
  await connectDb();
  if ((await LeadSource.countDocuments({ organizationId: user.organizationId })) >= 20) throw Errors.validation("You can have up to 20 lead sources.");
  const { secret, secretHash, secretHint } = newSecret();
  const slug = `src_${randomBytes(8).toString("hex")}`;
  const doc = await LeadSource.create({ organizationId: user.organizationId, name: input.name, slug, defaultCategory: input.defaultCategory, fieldMap: input.fieldMap, secretHash, secretHint, createdBy: user.id });
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "lead_source.created", entityType: "lead_source", entityId: doc._id });
  return { source: sourceDto(doc.toObject() as never), secret };
}

export async function updateLeadSource(user: CurrentUser, id: string, raw: unknown) {
  assertManage(user);
  const input = sourceUpdateSchema.parse(raw);
  await connectDb();
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Lead source");
  const doc = await LeadSource.findOneAndUpdate({ _id: id, organizationId: user.organizationId }, { $set: input }, { returnDocument: "after" }).lean();
  if (!doc) throw Errors.notFound("Lead source");
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "lead_source.updated", entityType: "lead_source", entityId: doc._id, metadata: { fields: Object.keys(input) } });
  return sourceDto(doc as never);
}

/** Issues a new key; the old one stops working immediately. */
export async function rotateLeadSourceSecret(user: CurrentUser, id: string) {
  assertManage(user);
  await connectDb();
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Lead source");
  const { secret, secretHash, secretHint } = newSecret();
  const doc = await LeadSource.findOneAndUpdate({ _id: id, organizationId: user.organizationId }, { $set: { secretHash, secretHint } }, { returnDocument: "after" }).lean();
  if (!doc) throw Errors.notFound("Lead source");
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "lead_source.key_rotated", entityType: "lead_source", entityId: doc._id });
  return { source: sourceDto(doc as never), secret };
}

export async function leadSourceLogs(user: CurrentUser, id: string) {
  assertManage(user);
  await connectDb();
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Lead source");
  const rows = await LeadSubmissionLog.find({ organizationId: user.organizationId, sourceId: id }).sort({ receivedAt: -1 }).limit(50).lean();
  return rows.map((r) => ({ at: r.receivedAt.toISOString(), outcome: r.outcome, externalId: r.externalId ?? null, leadId: r.leadId ? String(r.leadId) : null, error: r.error ?? null }));
}

// ---------------------------------------------------------------------------
// Intake (server-to-server)
// ---------------------------------------------------------------------------

export const INTAKE_LIMITS = {
  perSource: { bucket: "lead-intake:source", limit: 120, windowSeconds: 60 },
  perIp: { bucket: "lead-intake:ip", limit: 60, windowSeconds: 60 },
  badAuthPerIp: { bucket: "lead-intake:badauth", limit: 20, windowSeconds: 15 * 60 },
};

type IntakeOutcome = { status: number; body: Record<string, unknown>; retryAfter?: number };

async function log(source: { _id: Types.ObjectId; organizationId: Types.ObjectId } | null, slug: string, outcome: "accepted" | "duplicate" | "rejected" | "unauthorized" | "rate_limited", extra: { externalId?: string | null; leadId?: Types.ObjectId | null; error?: string | null } = {}) {
  try {
    await LeadSubmissionLog.create({ organizationId: source?.organizationId ?? null, sourceId: source?._id ?? null, sourceSlug: slug.slice(0, 40), outcome, externalId: extra.externalId?.slice(0, 200) ?? null, leadId: extra.leadId ?? null, error: extra.error?.slice(0, 300) ?? null });
  } catch {
    /* logging never blocks intake */
  }
}

function bearer(headers: Headers): string | null {
  const auth = headers.get("authorization") ?? "";
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim();
  return headers.get("x-realtypacer-key")?.trim() || null;
}

function safeEqualHex(a: string, b: string) {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function flatten(payload: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return out;
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(obj).slice(0, 100)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v === null || v === undefined) continue;
      if (typeof v === "object" && !Array.isArray(v) && depth < 2) walk(v as Record<string, unknown>, key, depth + 1);
      else out[key.slice(0, 100)] = (Array.isArray(v) ? v.map(String).join(", ") : String(v)).slice(0, 5000);
    }
  };
  walk(payload as Record<string, unknown>, "", 0);
  return out;
}

function toDateKey(v: string): string | null {
  if (isDateKey(v)) return v;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) || (v as string).length < 6 ? null : d.toISOString().slice(0, 10);
}

function toIntent(v: string): string {
  const s = v.toLowerCase();
  if (/buy|purchas/.test(s)) return "buyer";
  if (/sell/.test(s)) return "seller";
  if (/rent|lease|tenant/.test(s)) return "renter";
  return (RE_INTENTS as readonly string[]).includes(s) ? s : s ? "other" : "";
}

/** Maps a flattened payload to lead input. Values that fail validation are kept in notes rather than dropped. */
export function mapSubmission(fields: Record<string, string>, fieldMap: Record<string, string>, defaultCategory: LeadCategory) {
  const own = new Map(Object.entries(fieldMap).map(([k, v]) => [keyOf(k), v as IntakeTarget]));
  const v: Partial<Record<IntakeTarget, string>> = {};
  const extras: string[] = [];
  for (const [k, raw] of Object.entries(fields)) {
    const value = raw.trim();
    if (!value) continue;
    const target = own.get(keyOf(k)) ?? DEFAULT_SYNONYMS[keyOf(k)] ?? DEFAULT_SYNONYMS[keyOf(k.split(".").pop() ?? "")];
    if (target && !v[target]) v[target] = value;
    else if (!/secret|token|key|password|captcha|nonce/i.test(k)) extras.push(`${k}: ${value.slice(0, 300)}`);
  }
  const notes: string[] = v.notes ? [v.notes] : [];
  const category: LeadCategory = v.category === "real_estate" || /real.?estate|realty|property/i.test(v.category ?? "") ? "real_estate" : v.category === "general" || /service|clean/i.test(v.category ?? "") ? "general" : defaultCategory;
  let phone = v.phone ?? "";
  if (phone && !parsePhone(phone)) {
    notes.push(`Phone as submitted: ${phone}`);
    phone = "";
  }
  let email = v.email ?? "";
  if (email && !z.string().email().safeParse(email).success) {
    notes.push(`Email as submitted: ${email}`);
    email = "";
  }
  let preferredDate = "";
  if (v.preferredDate) {
    preferredDate = toDateKey(v.preferredDate) ?? "";
    if (!preferredDate) notes.push(`Preferred date as submitted: ${v.preferredDate}`);
  }
  let listingUrl = v.listingUrl ?? "";
  if (listingUrl && !isSafeHttpUrl(listingUrl)) {
    notes.push(`Listing as submitted: ${listingUrl}`);
    listingUrl = "";
  }
  let budgetCents: number | null = null;
  if (v.budget) {
    const n = Number(v.budget.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0 && n < 1e9) budgetCents = Math.round(n * 100);
    else notes.push(`Budget as submitted: ${v.budget}`);
  }
  if (extras.length) notes.push(`Other form fields:\n${extras.slice(0, 30).join("\n")}`);
  const name = (v.name ?? [v.firstName, v.lastName].filter(Boolean).join(" ")).slice(0, 160);
  return {
    externalId: v.externalId?.slice(0, 160) ?? null,
    input: {
      category,
      name,
      phone,
      email,
      city: (v.city ?? "").slice(0, 100),
      address: (v.address ?? "").slice(0, 300),
      notes: notes.join("\n\n").slice(0, 5000),
      requestedService: (v.requestedService ?? "").slice(0, 200),
      preferredDate,
      serviceLocation: (v.serviceLocation ?? "").slice(0, 300),
      intent: category === "real_estate" ? toIntent(v.intent ?? "") : "",
      areaOfInterest: (v.areaOfInterest ?? "").slice(0, 200),
      budgetCents,
      listingUrl,
    },
  };
}

/**
 * Handles one submission. Never throws for client errors: returns the HTTP
 * status and a body that never echoes secrets.
 */
export async function receiveSubmission(p: { slug: string; headers: Headers; payload: unknown; ip: string | null }): Promise<IntakeOutcome> {
  await connectDb();
  const slug = p.slug.slice(0, 40);
  const unauthorized: IntakeOutcome = { status: 401, body: { error: { code: "UNAUTHORIZED", message: "Unknown source or invalid key." } } };
  const key = bearer(p.headers);
  const source = /^src_[a-f0-9]{16}$/.test(slug) ? await LeadSource.findOne({ slug }).lean() : null;
  if (!source || !key || key.length > 200 || !safeEqualHex(sha256(key), source.secretHash) || source.active === false) {
    const limited = p.ip ? !(await hit(INTAKE_LIMITS.badAuthPerIp, p.ip)).allowed : false;
    await log(source && key ? (source as never) : null, slug, "unauthorized", { error: !source ? "unknown source" : !key ? "missing key" : source.active === false ? "source disabled" : "invalid key" });
    return limited ? { status: 429, body: { error: { code: "RATE_LIMITED", message: "Too many failed attempts." } }, retryAfter: 900 } : unauthorized;
  }
  for (const [rule, id] of [[INTAKE_LIMITS.perSource, String(source._id)], [INTAKE_LIMITS.perIp, p.ip]] as const) {
    if (!id) continue;
    const r = await hit(rule, id);
    if (!r.allowed) {
      await log(source as never, slug, "rate_limited");
      return { status: 429, body: { error: { code: "RATE_LIMITED", message: "Too many submissions. Retry later." } }, retryAfter: r.retryAfterSeconds };
    }
  }

  const fields = flatten(p.payload);
  const mapped = mapSubmission(fields, (source.fieldMap ?? {}) as Record<string, string>, source.defaultCategory as LeadCategory);
  const headerKey = p.headers.get("idempotency-key")?.trim().slice(0, 160) || null;
  const canonical = JSON.stringify(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));
  const externalId = mapped.externalId ?? headerKey ?? `hash:${sha256(canonical).slice(0, 40)}`;

  const existing = await Lead.findOne({ organizationId: source.organizationId, sourceId: source._id, externalId }).select("_id").lean();
  if (existing) {
    await log(source as never, slug, "duplicate", { externalId, leadId: existing._id });
    return { status: 200, body: { data: { id: String(existing._id), duplicate: true } } };
  }

  const parsed = leadInputSchema.safeParse({ ...mapped.input, source: source.name });
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => ({ field: i.path.join(".") || "body", message: i.message }));
    await log(source as never, slug, "rejected", { externalId, error: issues.map((i) => `${i.field}: ${i.message}`).join("; ") });
    return { status: 422, body: { error: { code: "VALIDATION_ERROR", message: "The submission is missing required details (a name and a phone or email).", issues } } };
  }
  const now = new Date();
  try {
    const [doc] = await Lead.create([
      {
        organizationId: source.organizationId,
        channel: "intake",
        ...leadFields(parsed.data, "UTC"),
        source: source.name,
        sourceId: source._id,
        externalId,
        receivedAt: now,
        history: [{ at: now, by: null, kind: "created", text: `Received from ${source.name}` }],
      },
    ]);
    await LeadSource.updateOne({ _id: source._id }, { $set: { lastReceivedAt: now }, $inc: { receivedCount: 1 } });
    await log(source as never, slug, "accepted", { externalId, leadId: doc!._id });
    return { status: 201, body: { data: { id: String(doc!._id), duplicate: false } } };
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const again = await Lead.findOne({ organizationId: source.organizationId, sourceId: source._id, externalId }).select("_id").lean();
      await log(source as never, slug, "duplicate", { externalId, leadId: again?._id ?? null });
      return { status: 200, body: { data: { id: again ? String(again._id) : null, duplicate: true } } };
    }
    if (err instanceof AppError) {
      await log(source as never, slug, "rejected", { externalId, error: err.message });
      return { status: 422, body: { error: { code: err.code, message: err.message } } };
    }
    throw err;
  }
}
