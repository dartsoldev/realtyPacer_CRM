import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { AuditEvent } from "@/lib/db/models/audit-event";
import { User } from "@/lib/db/models/user";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/security/redact";

export type AuditMetadata = Record<string, string | number | boolean | null | string[]>;

export type AuditInput = {
  organizationId: Types.ObjectId | string;
  actorId?: Types.ObjectId | string | null;
  action: string;
  entityType: string;
  entityId?: Types.ObjectId | string | null;
  metadata?: AuditMetadata;
};

/**
 * Records an audit event. Metadata is redacted (secrets removed, emails
 * masked). Audit failures are logged but never break the primary operation.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await connectDb();
    await AuditEvent.create({
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      metadata: redact(input.metadata ?? {}),
    });
  } catch (err) {
    logger.error("audit.write_failed", { action: input.action, error: err as Error });
  }
}

export const auditListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  action: z
    .string()
    .regex(/^[a-z_.]{1,80}$/)
    .optional(),
});

export type AuditListItem = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { id: string; name: string } | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export async function listAuditEvents(actor: CurrentUser, query: z.infer<typeof auditListQuery>) {
  await connectDb();
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(actor.organizationId) };
  if (query.action) filter.action = query.action;
  const [total, events] = await Promise.all([
    AuditEvent.countDocuments(filter),
    AuditEvent.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean(),
  ]);
  // One query for all actor names (no N+1).
  const actorIds = [...new Set(events.map((e) => e.actorId && String(e.actorId)).filter(Boolean))] as string[];
  const actors = actorIds.length
    ? await User.find({ _id: { $in: actorIds }, organizationId: actor.organizationId }).select("name").lean()
    : [];
  const names = new Map(actors.map((a) => [String(a._id), a.name]));
  const items: AuditListItem[] = events.map((e) => ({
    id: String(e._id),
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ? String(e.entityId) : null,
    actor: e.actorId ? { id: String(e.actorId), name: names.get(String(e.actorId)) ?? "Former user" } : null,
    metadata: (e.metadata ?? {}) as Record<string, unknown>,
    createdAt: e.createdAt.toISOString(),
  }));
  return { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) };
}
