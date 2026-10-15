import "server-only";
import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Customer } from "@/lib/db/models/customer";
import { Lead, LEAD_CATEGORIES, LEAD_STATUSES, RE_INTENTS, type LeadCategory, type LeadDoc, type LeadStatus } from "@/lib/db/models/lead";
import { User } from "@/lib/db/models/user";
import { parseCsv } from "@/lib/domain/csv-parse";
import { isSafeHttpUrl } from "@/lib/domain/links";
import { escapeRegex, normalizeEmail, OBJECT_ID_RE } from "@/lib/domain/normalize";
import { parsePhone } from "@/lib/domain/phone";
import { isDateKey } from "@/lib/domain/zoned-time";
import { AppError, Errors } from "@/lib/http/errors";
import { recordActivity } from "@/modules/activities/service";
import { recordAudit } from "@/modules/audit/service";
import { createCustomer } from "@/modules/customers/service";

const text = (max: number) => z.string().trim().max(max);

/** Fields shared by both categories plus category-specific ones. */
export const leadInputSchema = z
  .object({
    category: z.enum(LEAD_CATEGORIES),
    name: text(160).min(1, "Name is required"),
    phone: text(40).default(""),
    email: z.union([z.literal(""), text(254).email("Enter a valid email or leave it blank")]).default(""),
    city: text(100).default(""),
    address: text(300).default(""),
    source: text(120).default(""),
    receivedDate: z.string().refine(isDateKey, "Choose a valid date").optional(),
    notes: text(5000).default(""),
    assignedTo: z.string().regex(OBJECT_ID_RE).nullable().optional(),
    // General / service
    requestedService: text(200).default(""),
    preferredDate: z.union([z.literal(""), z.string().refine(isDateKey, "Choose a valid date")]).default(""),
    serviceLocation: text(300).default(""),
    // Real estate
    intent: z.union([z.literal(""), z.enum(RE_INTENTS)]).default(""),
    areaOfInterest: text(200).default(""),
    budgetCents: z.number().int().min(0).max(100_000_000_000).nullable().optional(),
    listingUrl: z.union([z.literal(""), text(2000).refine(isSafeHttpUrl, "Enter a full http(s) link")]).default(""),
  })
  .strict()
  .refine((v) => v.phone || v.email, { message: "Add a phone number or an email address", path: ["phone"] });
export type LeadInput = z.infer<typeof leadInputSchema>;

function assertRead(user: CurrentUser) {
  if (!user.permissions.has("leads:read")) throw Errors.forbidden();
}
function assertWrite(user: CurrentUser) {
  if (!user.permissions.has("leads:write")) throw Errors.forbidden();
}

/** Normalizes a validated lead into stored fields. Throws on an invalid phone. */
export function leadFields(input: LeadInput, tz: string) {
  let phone: ReturnType<typeof parsePhone> = null;
  if (input.phone) {
    phone = parsePhone(input.phone);
    if (!phone) throw Errors.validation("Enter a valid phone number.", { phone: ["Enter a valid phone number, including the area code."] });
  }
  void tz;
  return {
    category: input.category,
    name: input.name,
    searchName: input.name.toLowerCase(),
    phone: phone?.e164 ?? null,
    phoneDisplay: phone?.display ?? null,
    email: input.email ? normalizeEmail(input.email) : null,
    city: input.city,
    address: input.address,
    source: input.source,
    notes: input.notes,
    service: input.category === "general" ? { requestedService: input.requestedService, preferredDate: input.preferredDate || null, serviceLocation: input.serviceLocation } : null,
    realEstate: input.category === "real_estate" ? { intent: input.intent || null, areaOfInterest: input.areaOfInterest, budgetCents: input.budgetCents ?? null, listingUrl: input.listingUrl } : null,
  };
}

async function assertAssignee(orgId: string, userId: string | null | undefined) {
  if (!userId) return null;
  const u = await User.findOne({ _id: userId, organizationId: orgId, status: "active", role: { $ne: "CLEANER" } }).select("_id").lean();
  if (!u) throw Errors.validation("Choose an active staff member.");
  return u._id;
}

export async function createLead(user: CurrentUser, raw: unknown) {
  assertWrite(user);
  const input = leadInputSchema.parse(raw);
  await connectDb();
  const assignedTo = await assertAssignee(user.organizationId, input.assignedTo);
  const now = new Date();
  const [doc] = await Lead.create([
    {
      organizationId: user.organizationId,
      channel: "manual",
      ...leadFields(input, user.organization.timezone),
      source: input.source || "Manual entry",
      receivedAt: input.receivedDate ? new Date(`${input.receivedDate}T12:00:00Z`) : now,
      assignedTo,
      history: [{ at: now, by: user.id, kind: "created", text: "Added manually" }],
      createdBy: user.id,
    },
  ]);
  return { id: String(doc!._id) };
}

export type LeadRow = {
  id: string;
  category: LeadCategory;
  name: string;
  phone: string | null;
  phoneDisplay: string | null;
  email: string | null;
  city: string;
  source: string;
  channel: string;
  status: LeadStatus;
  receivedAt: string;
  assignedTo: { id: string; name: string } | null;
  summary: string;
  convertedCustomerId: string | null;
};

function summaryOf(l: LeadDoc): string {
  if (l.category === "general") return [l.service?.requestedService, l.service?.preferredDate ? `preferred ${l.service.preferredDate}` : ""].filter(Boolean).join(" · ");
  return [l.realEstate?.intent ? l.realEstate.intent[0]!.toUpperCase() + l.realEstate.intent.slice(1) : "", l.realEstate?.areaOfInterest].filter(Boolean).join(" · ");
}

export const leadListQuery = z.object({
  category: z.enum(LEAD_CATEGORIES).default("general"),
  status: z.enum([...LEAD_STATUSES, "open", "all"]).default("open"),
  q: text(100).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

export async function listLeads(user: CurrentUser, q: z.infer<typeof leadListQuery>) {
  assertRead(user);
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  const filter: Record<string, unknown> = { organizationId: orgId, category: q.category };
  if (q.status === "open") filter.status = { $in: ["new", "contacted", "qualified"] };
  else if (q.status !== "all") filter.status = q.status;
  if (q.q) {
    const re = escapeRegex(q.q.toLowerCase());
    const digits = q.q.replace(/\D/g, "");
    filter.$or = [{ searchName: { $regex: re } }, { email: { $regex: re } }, ...(digits.length >= 3 ? [{ phone: { $regex: escapeRegex(digits) } }] : [])];
  }
  const pageSize = 25;
  const [total, rows, counts] = await Promise.all([
    Lead.countDocuments(filter),
    Lead.find(filter).sort({ receivedAt: -1, _id: -1 }).skip((q.page - 1) * pageSize).limit(pageSize).lean(),
    Lead.aggregate<{ _id: { c: string; s: string }; n: number }>([{ $match: { organizationId: orgId } }, { $group: { _id: { c: "$category", s: "$status" }, n: { $sum: 1 } } }]),
  ]);
  const users = new Map((await User.find({ _id: { $in: rows.map((r) => r.assignedTo).filter(Boolean) }, organizationId: orgId }).select("name").lean()).map((u) => [String(u._id), u.name]));
  const countOf = (c: string, statuses: string[]) => counts.filter((x) => x._id.c === c && statuses.includes(x._id.s)).reduce((s, x) => s + x.n, 0);
  return {
    items: (rows as LeadDoc[]).map<LeadRow>((l) => ({
      id: String(l._id),
      category: l.category as LeadCategory,
      name: l.name,
      phone: l.phone ?? null,
      phoneDisplay: l.phoneDisplay ?? null,
      email: l.email ?? null,
      city: l.city ?? "",
      source: l.source ?? "",
      channel: l.channel,
      status: l.status as LeadStatus,
      receivedAt: l.receivedAt.toISOString(),
      assignedTo: l.assignedTo ? { id: String(l.assignedTo), name: users.get(String(l.assignedTo)) ?? "Former user" } : null,
      summary: summaryOf(l),
      convertedCustomerId: l.convertedCustomerId ? String(l.convertedCustomerId) : null,
    })),
    counts: { generalNew: countOf("general", ["new"]), realEstateNew: countOf("real_estate", ["new"]), generalOpen: countOf("general", ["new", "contacted", "qualified"]), realEstateOpen: countOf("real_estate", ["new", "contacted", "qualified"]) },
    page: q.page,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getLead(user: CurrentUser, id: string) {
  assertRead(user);
  await connectDb();
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Lead");
  const l = (await Lead.findOne({ _id: id, organizationId: user.organizationId }).lean()) as LeadDoc | null;
  if (!l) throw Errors.notFound("Lead");
  const userIds = [l.assignedTo, l.convertedBy, ...l.history.map((h) => h.by)].filter(Boolean).map(String);
  const users = new Map((await User.find({ _id: { $in: userIds }, organizationId: user.organizationId }).select("name").lean()).map((u) => [String(u._id), u.name]));
  return {
    id: String(l._id),
    category: l.category as LeadCategory,
    channel: l.channel,
    source: l.source ?? "",
    name: l.name,
    phone: l.phone ?? null,
    phoneDisplay: l.phoneDisplay ?? null,
    email: l.email ?? null,
    city: l.city ?? "",
    address: l.address ?? "",
    receivedAt: l.receivedAt.toISOString(),
    status: l.status as LeadStatus,
    assignedTo: l.assignedTo ? { id: String(l.assignedTo), name: users.get(String(l.assignedTo)) ?? "Former user" } : null,
    notes: l.notes ?? "",
    service: l.service ? { requestedService: l.service.requestedService ?? "", preferredDate: l.service.preferredDate ?? null, serviceLocation: l.service.serviceLocation ?? "" } : null,
    realEstate: l.realEstate ? { intent: l.realEstate.intent ?? null, areaOfInterest: l.realEstate.areaOfInterest ?? "", budgetCents: l.realEstate.budgetCents ?? null, listingUrl: l.realEstate.listingUrl ?? "" } : null,
    convertedCustomerId: l.convertedCustomerId ? String(l.convertedCustomerId) : null,
    convertedAt: l.convertedAt?.toISOString() ?? null,
    externalId: l.externalId ?? null,
    history: l.history.map((h) => ({ at: h.at.toISOString(), by: h.by ? (users.get(String(h.by)) ?? "Former user") : "System", kind: h.kind, text: h.text })).reverse(),
  };
}

export const leadUpdateSchema = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    assignedTo: z.string().regex(OBJECT_ID_RE).nullable().optional(),
    note: text(2000).min(1).optional(),
  })
  .strict();

/** Status, assignment and notes. “converted” is only set by Convert to customer. */
export async function updateLead(user: CurrentUser, id: string, raw: unknown) {
  assertWrite(user);
  const input = leadUpdateSchema.parse(raw);
  await connectDb();
  const lead = await Lead.findOne({ _id: id, organizationId: user.organizationId }).select("status assignedTo").lean();
  if (!lead) throw Errors.notFound("Lead");
  const set: Record<string, unknown> = {};
  const history: { at: Date; by: string; kind: string; text: string }[] = [];
  const now = new Date();
  if (input.status && input.status !== lead.status) {
    if (input.status === "converted") throw Errors.validation("Use “Convert to customer” to convert a lead.");
    set.status = input.status;
    history.push({ at: now, by: user.id, kind: "status", text: `Status: ${lead.status} → ${input.status}` });
  }
  if (input.assignedTo !== undefined) {
    set.assignedTo = await assertAssignee(user.organizationId, input.assignedTo);
    history.push({ at: now, by: user.id, kind: "assigned", text: input.assignedTo ? "Assigned" : "Unassigned" });
  }
  if (input.note) history.push({ at: now, by: user.id, kind: "note", text: input.note });
  await Lead.updateOne({ _id: lead._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(history.length ? { $push: { history: { $each: history, $slice: -200 } } } : {}) });
  return getLead(user, id);
}

// ---------------------------------------------------------------------------
// Convert to customer
// ---------------------------------------------------------------------------

export async function conversionMatches(user: CurrentUser, id: string) {
  assertRead(user);
  if (!user.permissions.has("customers:read")) throw Errors.forbidden();
  const lead = await getLead(user, id);
  const or: Record<string, unknown>[] = [];
  if (lead.phone) or.push({ phone: lead.phone });
  if (lead.email) or.push({ email: lead.email });
  or.push({ searchName: lead.name.toLowerCase() });
  const rows = await Customer.find({ organizationId: user.organizationId, $or: or }).select("name phoneDisplay phone email primaryCity archivedAt").limit(10).lean();
  return rows.map((c) => ({
    id: String(c._id),
    name: c.name,
    phoneDisplay: c.phoneDisplay ?? c.phone ?? null,
    email: c.email ?? null,
    city: c.primaryCity ?? null,
    archived: Boolean(c.archivedAt),
    matchedOn: [...(lead.phone && c.phone === lead.phone ? ["phone"] : []), ...(lead.email && c.email === lead.email ? ["email"] : []), ...(c.name.toLowerCase() === lead.name.toLowerCase() ? ["name"] : [])],
  }));
}

export const convertSchema = z.union([z.object({ customerId: z.string().regex(OBJECT_ID_RE) }).strict(), z.object({ create: z.literal(true) }).strict()]);

/**
 * Links the lead to an existing customer, or creates one. Creation is
 * idempotent per lead (importRef "lead:<id>"), so a retried request never
 * creates a second customer. The lead keeps its source and history.
 */
export async function convertLead(user: CurrentUser, id: string, raw: unknown) {
  assertWrite(user);
  if (!user.permissions.has("customers:write")) throw Errors.forbidden("Converting needs permission to create customers.");
  const input = convertSchema.parse(raw);
  await connectDb();
  const lead = (await Lead.findOne({ _id: id, organizationId: user.organizationId }).lean()) as LeadDoc | null;
  if (!lead) throw Errors.notFound("Lead");
  if (lead.convertedCustomerId) {
    if ("customerId" in input && input.customerId !== String(lead.convertedCustomerId)) throw new AppError(409, "ALREADY_CONVERTED", "This lead is already linked to another customer.");
    return { customerId: String(lead.convertedCustomerId), created: false };
  }
  let customerId: string;
  let created = false;
  if ("customerId" in input) {
    const c = await Customer.findOne({ _id: input.customerId, organizationId: user.organizationId }).select("_id").lean();
    if (!c) throw Errors.notFound("Customer");
    customerId = String(c._id);
  } else {
    const [first, ...rest] = lead.name.split(/\s+/);
    const importRef = `lead:${lead._id}`;
    const dto = await createCustomer(
      user,
      {
        firstName: first ?? lead.name,
        lastName: rest.join(" "),
        phone: lead.phoneDisplay ?? lead.phone ?? "",
        email: lead.email ?? "",
        notes: [lead.notes, `Converted from ${lead.category === "real_estate" ? "real estate" : "service"} lead (${lead.source || lead.channel}).`].filter(Boolean).join("\n\n").slice(0, 5000),
        confirmDuplicate: true,
        ...(lead.address && lead.city ? { primaryAddress: { label: "", line1: lead.address, city: lead.city } } : {}),
      },
      { importRef },
    ).catch(async (err: unknown) => {
      // A concurrent retry created it first (unique importRef): use that customer.
      const prior = (err as { code?: number }).code === 11000 ? await Customer.findOne({ organizationId: user.organizationId, importRef }).select("_id").lean() : null;
      if (!prior) throw err;
      return { id: String(prior._id) };
    });
    customerId = dto.id;
    created = true;
  }
  const now = new Date();
  const res = await Lead.updateOne(
    { _id: lead._id, convertedCustomerId: null },
    { $set: { convertedCustomerId: new Types.ObjectId(customerId), convertedAt: now, convertedBy: user.id, status: "converted" }, $push: { history: { $each: [{ at: now, by: user.id, kind: "converted", text: created ? "Converted to a new customer" : "Linked to an existing customer" }], $slice: -200 } } },
  );
  if (res.matchedCount === 0) {
    const again = await Lead.findById(lead._id).select("convertedCustomerId").lean();
    return { customerId: String(again?.convertedCustomerId ?? customerId), created: false };
  }
  await recordActivity({ organizationId: user.organizationId, actorId: user.id, type: "note", customerId, content: `From ${lead.category === "real_estate" ? "real estate" : "service"} lead received ${lead.receivedAt.toISOString().slice(0, 10)} via ${lead.source || lead.channel}.`, dedupeKey: `lead-converted:${lead._id}` });
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "lead.converted", entityType: "lead", entityId: lead._id, metadata: { created } });
  return { customerId, created };
}

// ---------------------------------------------------------------------------
// CSV import (manual files): preview → import, retry-safe
// ---------------------------------------------------------------------------

const CSV_SYNONYMS: Record<string, keyof LeadInput> = {
  name: "name", fullname: "name", firstname: "name",
  phone: "phone", phonenumber: "phone", mobile: "phone",
  email: "email", emailaddress: "email",
  city: "city", address: "address", source: "source", notes: "notes", message: "notes", comments: "notes",
  service: "requestedService", requestedservice: "requestedService", preferreddate: "preferredDate", servicelocation: "serviceLocation", location: "serviceLocation",
  intent: "intent", type: "intent", buyerseller: "intent", area: "areaOfInterest", areaofinterest: "areaOfInterest", budget: "budgetCents", listing: "listingUrl", listingurl: "listingUrl", url: "listingUrl",
  date: "receivedDate", receiveddate: "receivedDate", received: "receivedDate",
};

export const leadCsvSchema = z.object({ category: z.enum(LEAD_CATEGORIES), csv: z.string().min(1).max(2 * 1024 * 1024), commit: z.boolean().default(false) }).strict();

export async function importLeadsCsv(user: CurrentUser, raw: unknown) {
  assertWrite(user);
  const input = leadCsvSchema.parse(raw);
  await connectDb();
  let rows: string[][];
  try {
    rows = parseCsv(input.csv, 2001);
  } catch (e) {
    throw Errors.validation(e instanceof Error ? e.message : "The file could not be read as CSV.");
  }
  if (rows.length < 2) throw Errors.validation("The file needs a header row and at least one lead.");
  const headers = rows[0]!.map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const mapped = headers.map((h) => CSV_SYNONYMS[h] ?? null);
  if (!mapped.includes("name")) throw Errors.validation("Add a “Name” column.");
  const results: { row: number; ok: boolean; error?: string; duplicate?: boolean }[] = [];
  let created = 0;
  for (const [i, r] of rows.slice(1).entries()) {
    const obj: Record<string, unknown> = { category: input.category };
    mapped.forEach((k, j) => {
      if (!k) return;
      const v = (r[j] ?? "").trim();
      if (k === "budgetCents") obj.budgetCents = v ? Math.round(Number(v.replace(/[^0-9.]/g, "")) * 100) || null : null;
      else if (k === "intent") obj.intent = (RE_INTENTS as readonly string[]).includes(v.toLowerCase()) ? v.toLowerCase() : "";
      else obj[k] = v;
    });
    const parsed = leadInputSchema.safeParse(obj);
    if (!parsed.success) {
      results.push({ row: i + 2, ok: false, error: parsed.error.issues[0]?.message });
      continue;
    }
    let fields;
    try {
      fields = leadFields(parsed.data, user.organization.timezone);
    } catch (e) {
      results.push({ row: i + 2, ok: false, error: e instanceof Error ? e.message : "Invalid" });
      continue;
    }
    // Same row content → same external id: re-importing the file never duplicates.
    const externalId = `csv:${createHash("sha256").update(`${input.category}|${r.join("\u0001")}`).digest("base64url").slice(0, 40)}`;
    if (!input.commit) {
      const exists = await Lead.exists({ organizationId: user.organizationId, sourceId: null, externalId });
      results.push({ row: i + 2, ok: true, duplicate: Boolean(exists) });
      continue;
    }
    try {
      await Lead.create({
        organizationId: user.organizationId,
        channel: "csv_import",
        ...fields,
        source: parsed.data.source || "CSV import",
        externalId,
        receivedAt: parsed.data.receivedDate ? new Date(`${parsed.data.receivedDate}T12:00:00Z`) : new Date(),
        history: [{ at: new Date(), by: user.id, kind: "created", text: "Imported from CSV" }],
        createdBy: user.id,
      });
      created++;
      results.push({ row: i + 2, ok: true });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) results.push({ row: i + 2, ok: true, duplicate: true });
      else throw err;
    }
  }
  return {
    committed: input.commit,
    total: rows.length - 1,
    valid: results.filter((r) => r.ok && !r.duplicate).length,
    duplicates: results.filter((r) => r.duplicate).length,
    invalid: results.filter((r) => !r.ok),
    created,
  };
}

/** Staff who can be assigned leads (no cleaners). */
export async function assignableStaff(user: CurrentUser) {
  assertRead(user);
  await connectDb();
  return (await User.find({ organizationId: user.organizationId, status: "active", role: { $ne: "CLEANER" } }).select("name").sort({ name: 1 }).limit(200).lean()).map((u) => ({ id: String(u._id), name: u.name }));
}
