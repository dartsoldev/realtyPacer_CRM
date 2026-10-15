import "server-only";
import { randomInt } from "node:crypto";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Booking } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { CustomFieldDefinition } from "@/lib/db/models/custom-field";
import { Customer } from "@/lib/db/models/customer";
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_VISIBILITIES,
  FILTERABLE_CUSTOM_FIELD_TYPES,
  type CustomFieldEntity,
  type CustomFieldType,
  type CustomFieldVisibility,
} from "@/lib/domain/constants";
import { isSafeHttpUrl } from "@/lib/domain/links";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { isDateKey } from "@/lib/domain/zoned-time";
import { AppError, Errors } from "@/lib/http/errors";
import { recordAudit } from "@/modules/audit/service";

export const MAX_FIELDS_PER_ENTITY = 50;
export const MAX_INDEXED_PER_ENTITY = 5;
const DEFAULT_MAX_LENGTH: Partial<Record<CustomFieldType, number>> = { short_text: 200, long_text: 5000, url: 2000 };

export type CustomFieldDef = {
  id: string;
  key: string;
  entityType: CustomFieldEntity;
  label: string;
  dataType: CustomFieldType;
  options: { value: string; label: string; archived: boolean }[];
  validation: { maxLength: number | null; min: number | null; max: number | null; integer: boolean };
  required: boolean;
  order: number;
  archived: boolean;
  showInTable: boolean;
  filterable: boolean;
  indexed: boolean;
  visibility: CustomFieldVisibility;
};

type DefDoc = {
  _id: Types.ObjectId;
  key: string;
  entityType: string;
  label: string;
  dataType: string;
  options?: { value: string; label: string; archived?: boolean | null }[] | null;
  validation?: { maxLength?: number | null; min?: number | null; max?: number | null; integer?: boolean | null } | null;
  required?: boolean | null;
  order?: number | null;
  archivedAt?: Date | null;
  showInTable?: boolean | null;
  filterable?: boolean | null;
  indexed?: boolean | null;
  visibility?: string | null;
};

export function toDef(d: DefDoc): CustomFieldDef {
  return {
    id: String(d._id),
    key: d.key,
    entityType: d.entityType as CustomFieldEntity,
    label: d.label,
    dataType: d.dataType as CustomFieldType,
    options: (d.options ?? []).map((o) => ({ value: o.value, label: o.label, archived: Boolean(o.archived) })),
    validation: { maxLength: d.validation?.maxLength ?? null, min: d.validation?.min ?? null, max: d.validation?.max ?? null, integer: Boolean(d.validation?.integer) },
    required: Boolean(d.required),
    order: d.order ?? 0,
    archived: Boolean(d.archivedAt),
    showInTable: Boolean(d.showInTable),
    filterable: Boolean(d.filterable),
    indexed: Boolean(d.indexed),
    visibility: (d.visibility ?? "office") as CustomFieldVisibility,
  };
}

/** All definitions (active and archived) for an entity, ordered for forms. */
export async function customFieldDefsFor(organizationId: string | Types.ObjectId, entityType: CustomFieldEntity): Promise<CustomFieldDef[]> {
  await connectDb();
  const rows = await CustomFieldDefinition.find({ organizationId, entityType }).sort({ archivedAt: 1, order: 1, createdAt: 1 }).limit(MAX_FIELDS_PER_ENTITY * 2).lean();
  return rows.map(toDef);
}

/** Values a given audience may see. Archived fields are hidden but their data is kept. */
export function visibleCustomFieldValues(defs: CustomFieldDef[], values: unknown, audience: "office" | "assigned_cleaners"): Record<string, unknown> {
  const v = (values && typeof values === "object" ? values : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    if (d.archived) continue;
    if (audience === "assigned_cleaners" && d.visibility !== "assigned_cleaners") continue;
    if (v[d.key] !== undefined && v[d.key] !== null) out[d.key] = v[d.key];
  }
  return out;
}

function isEmpty(v: unknown) {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Validates one value against its definition; returns the normalized value. */
export function validateValue(d: CustomFieldDef, raw: unknown, previous: unknown): unknown {
  const fail = (msg: string): never => {
    throw Errors.validation(`${d.label}: ${msg}`, { [`customFields.${d.key}`]: [msg] });
  };
  if (isEmpty(raw)) return null;
  switch (d.dataType) {
    case "short_text":
    case "long_text": {
      if (typeof raw !== "string") fail("Enter text.");
      const t = (raw as string).trim();
      const max = d.validation.maxLength ?? DEFAULT_MAX_LENGTH[d.dataType]!;
      if (t.length > max) fail(`Use at most ${max} characters.`);
      return t || null;
    }
    case "url": {
      if (typeof raw !== "string" || raw.length > 2000 || !isSafeHttpUrl(raw.trim())) fail("Enter a full http(s) link.");
      return (raw as string).trim();
    }
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) fail("Enter a number.");
      if (d.validation.integer && !Number.isInteger(n)) fail("Enter a whole number.");
      if (d.validation.min !== null && n < d.validation.min) fail(`Minimum is ${d.validation.min}.`);
      if (d.validation.max !== null && n > d.validation.max) fail(`Maximum is ${d.validation.max}.`);
      return n;
    }
    case "date":
      if (!isDateKey(raw)) fail("Choose a valid date.");
      return raw;
    case "boolean":
      if (typeof raw !== "boolean") fail("Choose yes or no.");
      return raw;
    case "single_select": {
      const opt = d.options.find((o) => o.value === raw);
      // An archived option may stay as it was, but can't be newly chosen.
      if (!opt || (opt.archived && raw !== previous)) fail("Choose one of the options.");
      return raw;
    }
    case "multi_select": {
      if (!Array.isArray(raw) || raw.length > 50) fail("Choose from the options.");
      const prev = Array.isArray(previous) ? previous : [];
      const uniq = [...new Set(raw as unknown[])];
      for (const v of uniq) {
        const opt = d.options.find((o) => o.value === v);
        if (!opt || (opt.archived && !prev.includes(v))) fail("Choose from the options.");
      }
      return uniq;
    }
  }
  return null;
}

/**
 * Validates submitted custom-field values for an entity. Undeclared or
 * archived keys are rejected. Required-field policy: required on create;
 * on update a required value can't be cleared, but older records missing a
 * newly-required value stay valid until edited (find them with the
 * "is empty" filter). Returns the merged value object to store.
 */
export async function validateCustomFieldValues(
  organizationId: Types.ObjectId | string,
  entityType: CustomFieldEntity,
  input: Record<string, unknown> | undefined,
  existing: Record<string, unknown>,
  mode: "create" | "update",
): Promise<Record<string, unknown>> {
  const defs = await customFieldDefsFor(organizationId, entityType);
  const active = new Map(defs.filter((d) => !d.archived).map((d) => [d.key, d]));
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, raw] of Object.entries(input ?? {})) {
    const d = active.get(key);
    if (!d) throw Errors.validation("A custom field in the request doesn't exist or is archived.", { customFields: [`Unknown field ${key.slice(0, 40)}`] });
    const value = validateValue(d, raw, existing[key]);
    if (value === null) {
      if (d.required) throw Errors.validation(`${d.label} is required.`, { [`customFields.${key}`]: ["Required"] });
      delete merged[key];
    } else merged[key] = value;
  }
  if (mode === "create") {
    for (const d of active.values()) if (d.required && isEmpty(merged[d.key])) throw Errors.validation(`${d.label} is required.`, { [`customFields.${d.key}`]: ["Required"] });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

const optionInput = z.object({ value: z.string().regex(/^o_[a-z0-9]{4,12}$/).optional(), label: z.string().trim().min(1).max(80), archived: z.boolean().default(false) }).strict();
const validationInput = z
  .object({ maxLength: z.number().int().min(1).max(5000).nullable().optional(), min: z.number().finite().nullable().optional(), max: z.number().finite().nullable().optional(), integer: z.boolean().optional() })
  .strict()
  .default({});

const baseFields = {
  label: z.string().trim().min(1, "Label is required").max(80),
  options: z.array(optionInput).max(100).default([]),
  validation: validationInput,
  required: z.boolean().default(false),
  order: z.number().int().min(0).max(10_000).default(0),
  showInTable: z.boolean().default(false),
  filterable: z.boolean().default(false),
  indexed: z.boolean().default(false),
  visibility: z.enum(CUSTOM_FIELD_VISIBILITIES).default("office"),
};

export const createDefinitionSchema = z.object({ entityType: z.enum(CUSTOM_FIELD_ENTITIES), dataType: z.enum(CUSTOM_FIELD_TYPES), ...baseFields }).strict();
export const updateDefinitionSchema = z
  .object({
    label: baseFields.label.optional(),
    dataType: z.enum(CUSTOM_FIELD_TYPES).optional(),
    options: z.array(optionInput).max(100).optional(),
    validation: validationInput.optional(),
    required: z.boolean().optional(),
    order: z.number().int().min(0).max(10_000).optional(),
    showInTable: z.boolean().optional(),
    filterable: z.boolean().optional(),
    indexed: z.boolean().optional(),
    visibility: z.enum(CUSTOM_FIELD_VISIBILITIES).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

function newKey() {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let k = "cf_";
  for (let i = 0; i < 8; i++) k += a[randomInt(a.length)];
  return k;
}
function newOptionValue() {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let k = "o_";
  for (let i = 0; i < 6; i++) k += a[randomInt(a.length)];
  return k;
}

function checkTypeRules(dataType: CustomFieldType, f: { options?: { label: string }[]; filterable?: boolean; indexed?: boolean }) {
  const isSelect = dataType === "single_select" || dataType === "multi_select";
  if (isSelect && !(f.options?.length ?? 0)) throw Errors.validation("Select fields need at least one option.");
  if (!isSelect && (f.options?.length ?? 0) > 0) throw Errors.validation("Only select fields have options.");
  if (f.filterable && !FILTERABLE_CUSTOM_FIELD_TYPES.includes(dataType)) throw Errors.validation("Long text and links can't be used as report filters.");
  if (f.indexed && !f.filterable) throw Errors.validation("Only filterable fields can be indexed.");
}

function collectionFor(entityType: CustomFieldEntity) {
  return entityType === "customer" ? Customer : entityType === "booking" ? Booking : Cleaner;
}

export async function listDefinitions(user: CurrentUser, entityType?: CustomFieldEntity, includeArchived = false) {
  // Forms need definitions for the entity being edited; full admin needs customFields:manage.
  const canRead = user.permissions.has("customFields:manage") || user.permissions.has("customers:read") || user.permissions.has("bookings:read") || user.permissions.has("cleaners:read");
  if (!canRead) throw Errors.forbidden();
  await connectDb();
  const filter: Record<string, unknown> = { organizationId: user.organizationId };
  if (entityType) filter.entityType = entityType;
  if (!includeArchived || !user.permissions.has("customFields:manage")) filter.archivedAt = null;
  // Field-only viewers (e.g. cleaners) don't learn office-only field names.
  if (!user.permissions.has("customFields:manage") && !user.permissions.has("customers:read")) filter.visibility = "assigned_cleaners";
  const rows = await CustomFieldDefinition.find(filter).sort({ entityType: 1, archivedAt: 1, order: 1, createdAt: 1 }).limit(300).lean();
  return rows.map(toDef);
}

async function assertIndexBudget(orgId: Types.ObjectId, entityType: CustomFieldEntity, excludeId?: Types.ObjectId) {
  const n = await CustomFieldDefinition.countDocuments({ organizationId: orgId, entityType, indexed: true, archivedAt: null, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
  if (n >= MAX_INDEXED_PER_ENTITY) throw Errors.validation(`At most ${MAX_INDEXED_PER_ENTITY} indexed fields per record type.`);
}

export async function createDefinition(user: CurrentUser, raw: unknown) {
  if (!user.permissions.has("customFields:manage")) throw Errors.forbidden();
  const input = createDefinitionSchema.parse(raw);
  checkTypeRules(input.dataType, input);
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  if ((await CustomFieldDefinition.countDocuments({ organizationId: orgId, entityType: input.entityType })) >= MAX_FIELDS_PER_ENTITY) throw Errors.validation(`At most ${MAX_FIELDS_PER_ENTITY} fields per record type.`);
  if (input.indexed) await assertIndexBudget(orgId, input.entityType);
  const doc = await CustomFieldDefinition.create({
    organizationId: orgId,
    entityType: input.entityType,
    key: newKey(),
    label: input.label,
    dataType: input.dataType,
    options: input.options.map((o) => ({ value: newOptionValue(), label: o.label, archived: false })),
    validation: input.validation,
    required: input.required,
    order: input.order,
    showInTable: input.showInTable,
    filterable: input.filterable,
    indexed: input.indexed,
    visibility: input.visibility,
    createdBy: user.id,
  });
  await recordAudit({ organizationId: orgId, actorId: user.id, action: "custom_field.created", entityType: "custom_field", entityId: doc._id, metadata: { entity: input.entityType, type: input.dataType, label: input.label } });
  return toDef(doc.toObject());
}

/**
 * Label renames keep data (values are stored by key). Archiving hides the
 * field but keeps every stored value. Changing the type is refused while any
 * record holds a value (explicit migration required). Existing options can
 * be relabelled or archived, never removed.
 */
export async function updateDefinition(user: CurrentUser, id: string, raw: unknown) {
  if (!user.permissions.has("customFields:manage")) throw Errors.forbidden();
  const input = updateDefinitionSchema.parse(raw);
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("Custom field");
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  const cur = await CustomFieldDefinition.findOne({ _id: id, organizationId: orgId }).lean();
  if (!cur) throw Errors.notFound("Custom field");
  const def = toDef(cur);
  const dataType = input.dataType ?? def.dataType;
  const set: Record<string, unknown> = {};

  if (input.dataType && input.dataType !== def.dataType) {
    const Model = collectionFor(def.entityType) as unknown as import("mongoose").Model<Record<string, unknown>>;
    const inUse = await Model.countDocuments({ organizationId: orgId, [`customFields.${def.key}`]: { $exists: true, $ne: null } });
    if (inUse > 0) {
      throw new AppError(409, "TYPE_CHANGE_BLOCKED", `${inUse} record${inUse === 1 ? "" : "s"} already have a value for “${def.label}”. Changing its type would make them invalid. Create a new field instead, or clear those values first.`, { recordsWithValues: inUse });
    }
    set.dataType = input.dataType;
  }
  let options = def.options;
  if (input.options) {
    const byValue = new Map(def.options.map((o) => [o.value, o]));
    const kept = new Set<string>();
    options = input.options.map((o) => {
      if (o.value) {
        if (!byValue.has(o.value)) throw Errors.validation("Unknown option.");
        kept.add(o.value);
        return { value: o.value, label: o.label, archived: o.archived };
      }
      return { value: newOptionValue(), label: o.label, archived: false };
    });
    if (def.options.some((o) => !kept.has(o.value))) throw Errors.validation("Options can't be deleted because records may use them. Archive the option instead.");
    set.options = options;
  }
  const filterable = input.filterable ?? def.filterable;
  const indexed = input.indexed ?? def.indexed;
  checkTypeRules(dataType, { options: ["single_select", "multi_select"].includes(dataType) ? options.filter((o) => !o.archived) : options, filterable, indexed });
  if (indexed && !def.indexed) await assertIndexBudget(orgId, def.entityType, cur._id);
  for (const k of ["label", "validation", "required", "order", "showInTable", "filterable", "indexed", "visibility"] as const) if (input[k] !== undefined) set[k] = input[k];
  if (input.archived !== undefined) set.archivedAt = input.archived ? (cur.archivedAt ?? new Date()) : null;
  const doc = await CustomFieldDefinition.findOneAndUpdate({ _id: cur._id, organizationId: orgId }, { $set: set }, { returnDocument: "after" }).lean();
  await recordAudit({ organizationId: orgId, actorId: user.id, action: input.archived === true ? "custom_field.archived" : "custom_field.updated", entityType: "custom_field", entityId: cur._id, metadata: { fields: Object.keys(set) } });
  return toDef(doc!);
}
