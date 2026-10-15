import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { SavedView } from "@/lib/db/models/saved-view";
import { User } from "@/lib/db/models/user";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { Errors } from "@/lib/http/errors";
import { recordAudit } from "@/modules/audit/service";
import { REPORT_MODES, reportDefinitionSchema, resolveDatePreset, type ReportDefinition } from "./definition";

export const saveViewSchema = z
  .object({
    name: z.string().trim().min(1, "Name the view").max(80),
    visibility: z.enum(["private", "shared"]).default("private"),
    definition: reportDefinitionSchema,
  })
  .strict();

export const updateViewSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), visibility: z.enum(["private", "shared"]).optional(), definition: reportDefinitionSchema.optional() }).strict();

export type ViewDTO = { id: string; name: string; reportType: string; visibility: "private" | "shared"; owner: string; mine: boolean; definition: ReportDefinition; updatedAt: string };

/**
 * Re-validates a stored definition and resolves its date preset to today's
 * dates. Never adds access: the engine still applies the viewer's
 * permissions, and unknown/archived fields become warnings when run.
 */
export function prepareViewDefinition(raw: unknown, tz: string): { definition: ReportDefinition | null; problem: string | null } {
  const parsed = reportDefinitionSchema.safeParse(raw);
  if (!parsed.success) return { definition: null, problem: "This saved view is no longer valid (its settings use options that changed). Re-create it." };
  const def = parsed.data;
  if (def.datePreset !== "custom") {
    const r = resolveDatePreset(def.datePreset, tz);
    if (r) Object.assign(def, r);
  }
  return { definition: def, problem: null };
}

function assertReports(user: CurrentUser) {
  if (!user.permissions.has("reports:read")) throw Errors.forbidden();
}

export async function listViews(user: CurrentUser, reportType?: string): Promise<ViewDTO[]> {
  assertReports(user);
  await connectDb();
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(user.organizationId), $or: [{ ownerId: new Types.ObjectId(user.id) }, { visibility: "shared" }] };
  if (reportType && (REPORT_MODES as readonly string[]).includes(reportType)) filter.reportType = reportType;
  const rows = await SavedView.find(filter).sort({ name: 1, _id: 1 }).limit(200).lean();
  const owners = new Map((await User.find({ _id: { $in: rows.map((r) => r.ownerId) }, organizationId: user.organizationId }).select("name").lean()).map((u) => [String(u._id), u.name]));
  return rows.flatMap((r) => {
    const { definition } = prepareViewDefinition(r.definition, user.organization.timezone);
    if (!definition) return [];
    return [{ id: String(r._id), name: r.name, reportType: r.reportType, visibility: r.visibility as "private" | "shared", owner: owners.get(String(r.ownerId)) ?? "Former user", mine: String(r.ownerId) === user.id, definition, updatedAt: (r as unknown as { updatedAt: Date }).updatedAt.toISOString() }];
  });
}

export async function createView(user: CurrentUser, raw: unknown) {
  assertReports(user);
  const input = saveViewSchema.parse(raw);
  if (input.visibility === "shared" && !user.permissions.has("views:share")) throw Errors.forbidden("You can save private views only. Sharing needs permission.");
  await connectDb();
  const doc = await SavedView.create({ organizationId: user.organizationId, ownerId: user.id, name: input.name, reportType: input.definition.mode, definition: input.definition, visibility: input.visibility });
  if (input.visibility === "shared") await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "view.shared", entityType: "saved_view", entityId: doc._id, metadata: { name: input.name, mode: input.definition.mode } });
  return { id: String(doc._id) };
}

async function loadEditable(user: CurrentUser, id: string) {
  if (!OBJECT_ID_RE.test(id)) throw Errors.notFound("View");
  const v = await SavedView.findOne({ _id: id, organizationId: user.organizationId }).lean();
  if (!v) throw Errors.notFound("View");
  const mine = String(v.ownerId) === user.id;
  // Private views are only visible to their owner.
  if (!mine && v.visibility !== "shared") throw Errors.notFound("View");
  if (!mine && !user.permissions.has("views:share")) throw Errors.forbidden("Only the owner or someone who can share views may change this view.");
  return v;
}

export async function updateView(user: CurrentUser, id: string, raw: unknown) {
  assertReports(user);
  const input = updateViewSchema.parse(raw);
  await connectDb();
  const v = await loadEditable(user, id);
  if (input.visibility === "shared" && v.visibility !== "shared" && !user.permissions.has("views:share")) throw Errors.forbidden("Sharing views needs permission.");
  const set: Record<string, unknown> = {};
  if (input.name) set.name = input.name;
  if (input.visibility) set.visibility = input.visibility;
  if (input.definition) Object.assign(set, { definition: input.definition, reportType: input.definition.mode });
  await SavedView.updateOne({ _id: v._id }, { $set: set });
  if (v.visibility === "shared" || input.visibility === "shared") await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "view.shared_changed", entityType: "saved_view", entityId: v._id, metadata: { fields: Object.keys(set), visibility: input.visibility ?? v.visibility } });
  return { ok: true };
}

export async function deleteView(user: CurrentUser, id: string) {
  assertReports(user);
  await connectDb();
  const v = await loadEditable(user, id);
  await SavedView.deleteOne({ _id: v._id });
  if (v.visibility === "shared") await recordAudit({ organizationId: user.organizationId, actorId: user.id, action: "view.shared_deleted", entityType: "saved_view", entityId: v._id, metadata: { name: v.name } });
  return { ok: true };
}
