import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Customer } from "@/lib/db/models/customer";
import { ImportJob, type ImportJobDoc } from "@/lib/db/models/import-job";
import { ServiceAddress } from "@/lib/db/models/service-address";
import { CONTACT_SOURCES, CUSTOMER_TYPES } from "@/lib/domain/constants";
import { parseCsv } from "@/lib/domain/csv-parse";
import { normalizeEmail, OBJECT_ID_RE } from "@/lib/domain/normalize";
import { parsePhone } from "@/lib/domain/phone";
import { AppError, Errors } from "@/lib/http/errors";
import { enforce, RATE_LIMITS } from "@/lib/security/rate-limit";
import { recordAudit } from "@/modules/audit/service";
import { customFieldDefsFor, type CustomFieldDef } from "@/modules/custom-fields/service";
import { createAddress } from "@/modules/customers/addresses";
import { addressInputSchema, createCustomerSchema } from "@/modules/customers/schemas";
import { createCustomer, getCustomer, updateCustomer } from "@/modules/customers/service";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
export const IMPORT_BATCH = 100;

/** Allowlisted import targets. Custom fields add "cf:<key>" for active customer fields. */
export const BASE_TARGETS: Record<string, string> = {
  customerType: "Customer type (individual/business/referral_partner/other)",
  firstName: "First name",
  lastName: "Last name",
  displayName: "Business / display name",
  companyName: "Company",
  phone: "Phone",
  email: "Email",
  relationshipStartedAt: "Customer since (YYYY-MM-DD)",
  contactSource: "Contact source",
  tags: "Tags (separate with ; or ,)",
  notes: "Internal notes",
  "address.label": "Address label",
  "address.line1": "Address line 1",
  "address.line2": "Address line 2",
  "address.city": "City",
  "address.region": "Province / state",
  "address.postalCode": "Postal code",
  "address.country": "Country",
  "address.accessInstructions": "Access / parking notes",
};
const UPDATABLE = ["firstName", "lastName", "displayName", "companyName", "phone", "email", "relationshipStartedAt", "contactSource", "notes"] as const;

export const uploadSchema = z.object({ fileName: z.string().trim().max(200).default(""), csv: z.string().min(1, "The file is empty").max(MAX_IMPORT_BYTES, "The file is larger than 2 MB") }).strict();
export const mappingSchema = z.object({ mapping: z.record(z.string().regex(/^\d{1,3}$/), z.string().regex(/^(?:[a-zA-Z]+(?:\.[a-zA-Z][a-zA-Z0-9]*)?|cf:cf_[a-z0-9]{8})$/)) }).strict();
export const decisionsSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    decisions: z
      .array(z.object({ n: z.number().int().min(1), decision: z.enum(["create", "skip", "update"]), targetId: z.string().regex(OBJECT_ID_RE).optional(), overwrite: z.array(z.enum(UPDATABLE)).max(UPDATABLE.length).default([]) }).strict())
      .min(1)
      .max(MAX_IMPORT_ROWS),
  })
  .strict();

function assertImporter(user: CurrentUser) {
  if (!user.permissions.has("customers:import") || !user.permissions.has("customers:write")) throw Errors.forbidden();
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const SYNONYMS: Record<string, string> = {
  firstname: "firstName", first: "firstName", givenname: "firstName",
  lastname: "lastName", last: "lastName", surname: "lastName", familyname: "lastName",
  name: "displayName", businessname: "displayName", displayname: "displayName",
  company: "companyName", companyname: "companyName",
  phone: "phone", phonenumber: "phone", mobile: "phone", cell: "phone", telephone: "phone",
  email: "email", emailaddress: "email",
  customersince: "relationshipStartedAt", since: "relationshipStartedAt", startdate: "relationshipStartedAt",
  source: "contactSource", contactsource: "contactSource",
  tags: "tags", notes: "notes", type: "customerType", customertype: "customerType",
  address: "address.line1", address1: "address.line1", addressline1: "address.line1", street: "address.line1",
  address2: "address.line2", addressline2: "address.line2", unit: "address.line2",
  city: "address.city", province: "address.region", state: "address.region", region: "address.region",
  postalcode: "address.postalCode", zip: "address.postalCode", zipcode: "address.postalCode", postcode: "address.postalCode",
  country: "address.country", access: "address.accessInstructions", accessnotes: "address.accessInstructions", parking: "address.accessInstructions",
};

async function targetsFor(orgId: string): Promise<{ targets: Record<string, string>; defs: CustomFieldDef[] }> {
  const defs = (await customFieldDefsFor(orgId, "customer")).filter((d) => !d.archived);
  const targets = { ...BASE_TARGETS };
  for (const d of defs) targets[`cf:${d.key}`] = `Custom field: ${d.label}`;
  return { targets, defs };
}

function suggestMapping(headers: string[], targets: Record<string, string>, defs: CustomFieldDef[]): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  headers.forEach((h, i) => {
    const key = norm(h);
    let target = SYNONYMS[key];
    if (!target) {
      const d = defs.find((x) => norm(x.label) === key);
      if (d) target = `cf:${d.key}`;
    }
    if (target && targets[target] && !used.has(target)) {
      out[String(i)] = target;
      used.add(target);
    }
  });
  return out;
}

/** Downloadable template: headers plus one fictional example row. */
export async function importTemplate(user: CurrentUser): Promise<string> {
  assertImporter(user);
  await connectDb();
  const { defs } = await targetsFor(user.organizationId);
  const headers = ["First name", "Last name", "Business name", "Phone", "Email", "Customer since", "Tags", "Notes", "Address line 1", "Address line 2", "City", "Province", "Postal code", "Country", "Access notes", ...defs.map((d) => d.label)];
  const example = ["Sam", "Example", "", "(416) 555-0199", "sam.example@example.test", "2024-03-01", "weekly; pets", "Prefers mornings", "1 Sample Street", "", "Toronto", "ON", "M5V 0A1", "Canada", "Ring the side door", ...defs.map(() => "")];
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `﻿${[headers, example].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

export async function uploadImport(user: CurrentUser, raw: unknown) {
  assertImporter(user);
  const input = uploadSchema.parse(raw);
  await connectDb();
  await enforce([[RATE_LIMITS.importByUser, user.id]]);
  let parsed: string[][];
  try {
    parsed = parseCsv(input.csv, MAX_IMPORT_ROWS + 1);
  } catch (e) {
    throw Errors.validation(e instanceof Error ? e.message : "The file could not be read as CSV.");
  }
  if (parsed.length < 2) throw Errors.validation("The file needs a header row and at least one customer.");
  const headers = parsed[0]!.map((h) => h.trim().slice(0, 100));
  if (headers.length > 60) throw Errors.validation("The file has more than 60 columns.");
  const { targets, defs } = await targetsFor(user.organizationId);
  const [job] = await ImportJob.create([
    {
      organizationId: user.organizationId,
      createdBy: user.id,
      fileName: input.fileName.replace(/[^\w .()-]/g, "_"),
      headers,
      mapping: suggestMapping(headers, targets, defs),
      rows: parsed.slice(1).map((r, i) => ({ n: i + 1, raw: r.slice(0, headers.length).map((v) => v.slice(0, 5000)) })),
    },
  ]);
  await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "import.uploaded", entityType: "import", entityId: job!._id, metadata: { rows: parsed.length - 1 } });
  return { id: String(job!._id) };
}

async function loadJob(user: CurrentUser, id: string) {
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Import");
  const job = await ImportJob.findOne({ _id: id, organizationId: user.organizationId }).lean();
  if (!job) throw Errors.notFound("Import");
  return job as ImportJobDoc;
}

/** Converts a row into create-customer input plus custom fields, collecting errors. */
function rowInput(job: ImportJobDoc, raw: string[], defs: CustomFieldDef[]) {
  const mapping = (job.mapping ?? {}) as Record<string, string>;
  const v: Record<string, string> = {};
  for (const [idx, target] of Object.entries(mapping)) v[target] = (raw[Number(idx)] ?? "").trim();
  const errors: string[] = [];
  const customFields: Record<string, unknown> = {};
  for (const d of defs) {
    const value = v[`cf:${d.key}`];
    if (value === undefined || value === "") continue;
    switch (d.dataType) {
      case "number":
        if (Number.isFinite(Number(value))) customFields[d.key] = Number(value);
        else errors.push(`${d.label}: not a number`);
        break;
      case "boolean":
        if (/^(yes|y|true|1)$/i.test(value)) customFields[d.key] = true;
        else if (/^(no|n|false|0)$/i.test(value)) customFields[d.key] = false;
        else errors.push(`${d.label}: use yes or no`);
        break;
      case "single_select": {
        const opt = d.options.find((o) => !o.archived && o.label.toLowerCase() === value.toLowerCase());
        if (opt) customFields[d.key] = opt.value;
        else errors.push(`${d.label}: “${value.slice(0, 40)}” isn't an option`);
        break;
      }
      case "multi_select": {
        const parts = value.split(/[;|]/).map((p) => p.trim()).filter(Boolean);
        const vals = parts.map((p) => d.options.find((o) => !o.archived && o.label.toLowerCase() === p.toLowerCase())?.value);
        if (vals.every(Boolean)) customFields[d.key] = vals;
        else errors.push(`${d.label}: unknown option`);
        break;
      }
      default:
        customFields[d.key] = value;
    }
  }
  const type = (v.customerType || "").toLowerCase().replace(/\s+/g, "_");
  const source = (v.contactSource || "").toLowerCase().replace(/\s+/g, "_");
  const hasAddress = Boolean(v["address.line1"] || v["address.city"]);
  const input: Record<string, unknown> = {
    customerType: (CUSTOMER_TYPES as readonly string[]).includes(type) ? type : v.displayName && !v.firstName && !v.lastName ? "business" : "individual",
    firstName: v.firstName ?? "",
    lastName: v.lastName ?? "",
    displayName: v.displayName ?? "",
    companyName: v.companyName ?? "",
    phone: v.phone ?? "",
    email: (v.email ?? "").toLowerCase(),
    relationshipStartedAt: v.relationshipStartedAt ?? "",
    contactSource: (CONTACT_SOURCES as readonly string[]).includes(source) ? source : "",
    tags: (v.tags ?? "").split(/[;,]/).map((t) => t.trim()).filter(Boolean).slice(0, 20),
    notes: v.notes ?? "",
    customFields: Object.keys(customFields).length ? customFields : undefined,
    confirmDuplicate: true,
    ...(hasAddress
      ? {
          primaryAddress: {
            label: v["address.label"] ?? "",
            line1: v["address.line1"] ?? "",
            line2: v["address.line2"] ?? "",
            city: v["address.city"] ?? "",
            region: v["address.region"] ?? "",
            postalCode: v["address.postalCode"] ?? "",
            country: v["address.country"] || "Canada",
            accessInstructions: v["address.accessInstructions"] ?? "",
          },
        }
      : {}),
  };
  if (v.contactSource && !input.contactSource) errors.push(`Contact source “${v.contactSource.slice(0, 30)}” isn't recognised (left blank)`);
  const parsed = createCustomerSchema.safeParse(input);
  if (!parsed.success) for (const i of parsed.error.issues.slice(0, 5)) errors.push(`${i.path.join(".") || "row"}: ${i.message}`);
  for (const d of defs) if (d.required && customFields[d.key] === undefined) errors.push(`${d.label} is required`);
  const phone = input.phone ? parsePhone(String(input.phone)) : null;
  if (input.phone && !phone) errors.push("phone: not a valid phone number");
  return { input, errors, phone: phone?.e164 ?? null, email: input.email ? normalizeEmail(String(input.email)) : null, values: v };
}

/** Saves the column mapping, validates every row and finds duplicate candidates. */
export async function previewImport(user: CurrentUser, id: string, raw: unknown) {
  assertImporter(user);
  const { mapping } = mappingSchema.parse(raw);
  await connectDb();
  const job = await loadJob(user, id);
  if (job.status === "running" || job.status === "completed") throw new AppError(409, "IMPORT_STARTED", "This import has already started.");
  const { targets, defs } = await targetsFor(user.organizationId);
  const seen = new Set<string>();
  for (const [idx, target] of Object.entries(mapping)) {
    if (Number(idx) >= job.headers.length) throw Errors.validation("The mapping refers to a column that doesn't exist.");
    if (!targets[target]) throw Errors.validation(`“${target}” isn't a field you can import into.`);
    if (seen.has(target)) throw Errors.validation(`${targets[target]} is mapped twice.`);
    seen.add(target);
  }
  const withMapping = { ...job, mapping } as ImportJobDoc;
  const evaluated = job.rows.map((r) => ({ r, ...rowInput(withMapping, r.raw, defs) }));
  const phones = [...new Set(evaluated.map((e) => e.phone).filter(Boolean))] as string[];
  const emails = [...new Set(evaluated.map((e) => e.email).filter(Boolean))] as string[];
  const existing = phones.length || emails.length
    ? await Customer.find({ organizationId: user.organizationId, $or: [{ phone: { $in: phones } }, { email: { $in: emails } }] }).select("name phone email").limit(5000).lean()
    : [];
  const firstRowFor = new Map<string, number>();
  const rows = evaluated.map(({ r, errors, phone, email }) => {
    const dupes = existing
      .filter((c) => (phone && c.phone === phone) || (email && c.email === email))
      .slice(0, 5)
      .map((c) => ({ customerId: c._id, name: c.name, matchedOn: [...(phone && c.phone === phone ? ["phone"] : []), ...(email && c.email === email ? ["email"] : [])] }));
    const rowErrors = [...errors];
    for (const key of [phone && `p:${phone}`, email && `e:${email}`].filter(Boolean) as string[]) {
      const prior = firstRowFor.get(key);
      if (prior && prior !== r.n) rowErrors.push(`Same ${key.startsWith("p:") ? "phone" : "email"} as row ${prior} in this file`);
      else firstRowFor.set(key, r.n);
    }
    // Invalid rows are skipped; rows with possible duplicates wait for an explicit choice.
    const blocking = errors.length > 0;
    const decision = blocking ? "skip" : dupes.length || rowErrors.length > errors.length ? null : "create";
    return { n: r.n, raw: r.raw, problems: rowErrors, duplicates: dupes, decision, targetId: null, overwrite: [], result: null, resultId: null, resultError: null };
  });
  await ImportJob.updateOne({ _id: job._id }, { $set: { mapping, rows, status: "previewed" }, $inc: { revision: 1 } });
  return getImport(user, id);
}

export async function decideRows(user: CurrentUser, id: string, raw: unknown) {
  assertImporter(user);
  const input = decisionsSchema.parse(raw);
  await connectDb();
  const job = await loadJob(user, id);
  if (job.status !== "previewed") throw new AppError(409, "IMPORT_NOT_EDITABLE", "Decisions can only change before the import starts.");
  if (job.revision !== input.expectedRevision) throw new AppError(409, "STALE_VERSION", "The import changed in another window. Reload it.");
  const byN = new Map(job.rows.map((r) => [r.n, r]));
  const set: Record<string, unknown> = {};
  for (const d of input.decisions) {
    const row = byN.get(d.n);
    if (!row) throw Errors.validation(`Row ${d.n} doesn't exist.`);
    const idx = job.rows.indexOf(row);
    if (row.problems.length && d.decision !== "skip" && row.problems.some((e) => !e.startsWith("Same "))) throw Errors.validation(`Row ${d.n} has errors and can only be skipped.`);
    if (d.decision === "update" && !row.duplicates.some((x) => String(x.customerId) === d.targetId)) throw Errors.validation(`Row ${d.n}: choose one of the matching customers to update.`);
    set[`rows.${idx}.decision`] = d.decision;
    set[`rows.${idx}.targetId`] = d.decision === "update" ? new Types.ObjectId(d.targetId) : null;
    set[`rows.${idx}.overwrite`] = d.decision === "update" ? d.overwrite : [];
  }
  const res = await ImportJob.updateOne({ _id: job._id, revision: input.expectedRevision }, { $set: set, $inc: { revision: 1 } });
  if (res.matchedCount === 0) throw new AppError(409, "STALE_VERSION", "The import changed in another window. Reload it.");
  return getImport(user, id);
}

async function applyUpdate(user: CurrentUser, targetId: string, input: Record<string, unknown>, overwrite: string[]) {
  const cur = await getCustomer(user, targetId);
  const pick = (field: string, current: string | null) => {
    const incoming = String(input[field] ?? "").trim();
    if (!incoming) return current ?? "";
    return !current || overwrite.includes(field) ? incoming : current;
  };
  const individual = cur.customerType === "individual";
  const payload = {
    customerType: cur.customerType,
    firstName: pick("firstName", cur.firstName),
    lastName: pick("lastName", cur.lastName),
    displayName: individual ? "" : pick("displayName", cur.name),
    companyName: pick("companyName", cur.companyName),
    phone: pick("phone", cur.phoneDisplay ?? cur.phone),
    email: pick("email", cur.email),
    relationshipStartedAt: pick("relationshipStartedAt", cur.relationshipStartedAt),
    contactSource: pick("contactSource", cur.contactSource),
    tags: [...new Set([...cur.tags, ...((input.tags as string[]) ?? [])])].slice(0, 20),
    notes: pick("notes", cur.notes),
    // Custom fields: fill blanks only (existing values are never replaced by an import).
    customFields: Object.fromEntries(Object.entries((input.customFields as Record<string, unknown>) ?? {}).filter(([k]) => cur.customFields[k] === undefined || cur.customFields[k] === null)),
  };
  await updateCustomer(user, targetId, payload);
  const addr = input.primaryAddress as { line1: string; city: string } | undefined;
  if (addr?.line1 && addr.city) {
    const same = await ServiceAddress.exists({ organizationId: user.organizationId, customerId: targetId, archivedAt: null, line1: new RegExp(`^${addr.line1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), city: new RegExp(`^${addr.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    const parsedAddr = addressInputSchema.safeParse({ ...(addr as unknown as Record<string, unknown>), isPrimary: false });
    if (!same && parsedAddr.success) await createAddress(user, targetId, parsedAddr.data);
  }
}

/**
 * Processes the next batch of decided rows. Resumable and retry-safe: each row
 * records its result, and creations carry `importRef` so a repeated batch
 * returns the same customer instead of a duplicate.
 */
export async function runImportBatch(user: CurrentUser, id: string) {
  assertImporter(user);
  await connectDb();
  const job = await loadJob(user, id);
  if (job.status === "completed") return getImport(user, id);
  if (job.status === "uploaded") throw new AppError(409, "IMPORT_NOT_PREVIEWED", "Map the columns and review the rows first.");
  const undecided = job.rows.filter((r) => r.decision === null).length;
  if (undecided) throw new AppError(409, "ROWS_UNDECIDED", `${undecided} row(s) with possible duplicates still need a decision.`);
  if (job.status !== "running") {
    await ImportJob.updateOne({ _id: job._id, status: "previewed" }, { $set: { status: "running" }, $inc: { revision: 1 } });
    await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "import.started", entityType: "import", entityId: job._id });
  }
  const { defs } = await targetsFor(user.organizationId);
  const pending = job.rows.map((r, idx) => ({ r, idx })).filter(({ r }) => r.result === null).slice(0, IMPORT_BATCH);
  for (const { r, idx } of pending) {
    let result: "created" | "updated" | "skipped" | "failed" = "skipped";
    let resultId: Types.ObjectId | null = null;
    let resultError: string | null = null;
    try {
      if (r.decision === "create") {
        const { input } = rowInput(job, r.raw, defs);
        const c = await createCustomer(user, input, { importRef: `${job._id}:${r.n}` });
        result = "created";
        resultId = new Types.ObjectId(c.id);
      } else if (r.decision === "update" && r.targetId) {
        const { input } = rowInput(job, r.raw, defs);
        await applyUpdate(user, String(r.targetId), input, r.overwrite ?? []);
        result = "updated";
        resultId = r.targetId;
      }
    } catch (err) {
      result = "failed";
      resultError = err instanceof AppError ? err.message.slice(0, 300) : err instanceof z.ZodError ? (err.issues[0]?.message ?? "Invalid").slice(0, 300) : "Unexpected error";
    }
    await ImportJob.updateOne({ _id: job._id, [`rows.${idx}.result`]: null }, { $set: { [`rows.${idx}.result`]: result, [`rows.${idx}.resultId`]: resultId, [`rows.${idx}.resultError`]: resultError } });
  }
  const left = await ImportJob.countDocuments({ _id: job._id, "rows.result": null });
  if (!left) {
    await ImportJob.updateOne({ _id: job._id, status: "running" }, { $set: { status: "completed", completedAt: new Date() }, $inc: { revision: 1 } });
    const done = await loadJob(user, id);
    const count = (k: string) => done.rows.filter((x) => x.result === k).length;
    await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "import.completed", entityType: "import", entityId: job._id, metadata: { created: count("created"), updated: count("updated"), skipped: count("skipped"), failed: count("failed") } });
  }
  return getImport(user, id);
}

export type ImportView = Awaited<ReturnType<typeof getImport>>;

export async function getImport(user: CurrentUser, id: string, page = 1, filter: "all" | "attention" = "all") {
  assertImporter(user);
  await connectDb();
  const job = await loadJob(user, id);
  const { targets } = await targetsFor(user.organizationId);
  const count = (pred: (r: ImportJobDoc["rows"][number]) => boolean) => job.rows.filter(pred).length;
  const all = filter === "attention" ? job.rows.filter((r) => r.problems.length || r.duplicates.length || r.result === "failed") : job.rows;
  const pageSize = 50;
  const mapping = (job.mapping ?? {}) as Record<string, string>;
  const nameCols = ["firstName", "lastName", "displayName"].map((t) => Object.entries(mapping).find(([, v]) => v === t)?.[0]).filter(Boolean) as string[];
  const contactCols = ["phone", "email", "address.city"].map((t) => Object.entries(mapping).find(([, v]) => v === t)?.[0]).filter(Boolean) as string[];
  return {
    id: String(job._id),
    fileName: job.fileName,
    status: job.status,
    revision: job.revision,
    headers: job.headers,
    mapping,
    targets,
    sample: job.rows.slice(0, 3).map((r) => r.raw),
    totals: {
      rows: job.rows.length,
      valid: count((r) => r.problems.length === 0),
      withErrors: count((r) => r.problems.length > 0),
      duplicates: count((r) => r.duplicates.length > 0),
      undecided: count((r) => r.decision === null),
      toCreate: count((r) => r.decision === "create"),
      toUpdate: count((r) => r.decision === "update"),
      toSkip: count((r) => r.decision === "skip"),
      created: count((r) => r.result === "created"),
      updated: count((r) => r.result === "updated"),
      skipped: count((r) => r.result === "skipped"),
      failed: count((r) => r.result === "failed"),
      done: count((r) => r.result !== null),
    },
    rows: all.slice((page - 1) * pageSize, page * pageSize).map((r) => ({
      n: r.n,
      name: nameCols.map((c) => r.raw[Number(c)] ?? "").join(" ").trim(),
      contact: contactCols.map((c) => r.raw[Number(c)] ?? "").filter(Boolean).join(" · "),
      errors: r.problems,
      duplicates: r.duplicates.map((d) => ({ customerId: String(d.customerId), name: d.name ?? "", matchedOn: d.matchedOn ?? [] })),
      decision: r.decision,
      targetId: r.targetId ? String(r.targetId) : null,
      overwrite: r.overwrite ?? [],
      result: r.result,
      resultId: r.resultId ? String(r.resultId) : null,
      resultError: r.resultError,
    })),
    page,
    totalPages: Math.max(1, Math.ceil(all.length / pageSize)),
    updatableFields: UPDATABLE,
  };
}
