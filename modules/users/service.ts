import "server-only";
import { Types } from "mongoose";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { issueToken, recordDelivery, TOKEN_TTL_MS } from "@/lib/auth/tokens";
import { connectDb } from "@/lib/db/connect";
import { AuthToken } from "@/lib/db/models/auth-token";
import { User } from "@/lib/db/models/user";
import { ROLES, USER_STATUSES, type Role, type UserStatus } from "@/lib/domain/constants";
import { escapeRegex, normalizeEmail, OBJECT_ID_RE } from "@/lib/domain/normalize";
import { EmailDeliveryError, sendEmail } from "@/lib/email/mailer";
import { invitationEmail } from "@/lib/email/templates";
import { getSmtpEnv } from "@/lib/env";
import { Errors } from "@/lib/http/errors";
import { assignableRoles, canManageRole, STAFF_GRANTABLE } from "@/lib/permissions/matrix";
import { enforce, RATE_LIMITS } from "@/lib/security/rate-limit";
import { recordAudit } from "@/modules/audit/service";
import { appLink } from "@/modules/auth/links";

export const objectIdSchema = z.string().regex(OBJECT_ID_RE, "Invalid id");

export const userListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
});

const grantsSchema = z
  .array(z.string())
  .max(STAFF_GRANTABLE.length)
  .refine((g) => g.every((p) => (STAFF_GRANTABLE as string[]).includes(p)), "Contains a permission that cannot be granted")
  .transform((g) => [...new Set(g)]);

export const inviteUserSchema = z.object({
  email: z.string().trim().min(3).max(254).email("Enter a valid email address."),
  name: z.string().trim().min(1, "Name is required.").max(120),
  role: z.enum(ROLES),
  permissionGrants: grantsSchema.optional(),
});

export const updateUserSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    status: z.enum(["active", "suspended"]).optional(),
    permissionGrants: grantsSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type InvitationStatus = { status: "pending" | "sent" | "failed" | "not_sent"; expiresAt: string; expired: boolean; lastErrorCode: string | null };

export type UserListItem = {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  emailVerified: boolean;
  permissionGrants: string[];
  lastLoginAt: string | null;
  createdAt: string;
  invitation: InvitationStatus | null;
};

/** Explicit response allowlist — never passwordHash, sessionVersion, etc. */
function toListItem(u: {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: string;
  status: string;
  emailVerifiedAt?: Date | null;
  permissionGrants?: string[];
  lastLoginAt?: Date | null;
  createdAt: Date;
}, invitation: InvitationStatus | null): UserListItem {
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    role: u.role as Role,
    status: u.status as UserStatus,
    emailVerified: Boolean(u.emailVerifiedAt),
    permissionGrants: u.permissionGrants ?? [],
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    invitation,
  };
}

const LIST_FIELDS = "name email role status emailVerifiedAt permissionGrants lastLoginAt createdAt";

export async function listUsers(actor: CurrentUser, query: z.infer<typeof userListQuery>) {
  await connectDb();
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(actor.organizationId) };
  if (query.role) filter.role = query.role;
  if (query.status) filter.status = query.status;
  if (query.q) {
    const re = new RegExp(escapeRegex(query.q), "i");
    filter.$or = [{ name: re }, { email: re }];
  }
  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .select(LIST_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean(),
  ]);
  // Latest live invitation per invited user, in a single query.
  const invitedIds = users.filter((u) => u.status === "invited").map((u) => u._id);
  const invites = invitedIds.length
    ? await AuthToken.find({ userId: { $in: invitedIds }, purpose: "invitation", consumedAt: null, revokedAt: null })
        .sort({ createdAt: -1 })
        .select("userId expiresAt delivery")
        .lean()
    : [];
  const byUser = new Map<string, InvitationStatus>();
  for (const t of invites) {
    const key = String(t.userId);
    if (byUser.has(key)) continue;
    byUser.set(key, {
      status: (t.delivery?.status ?? "pending") as InvitationStatus["status"],
      expiresAt: t.expiresAt.toISOString(),
      expired: t.expiresAt.getTime() <= Date.now(),
      lastErrorCode: t.delivery?.lastErrorCode ?? null,
    });
  }
  return {
    items: users.map((u) => toListItem(u, byUser.get(String(u._id)) ?? null)),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  };
}

async function findOrgUser(actor: CurrentUser, userId: string) {
  if (!OBJECT_ID_RE.test(userId)) throw Errors.notFound("User");
  // Scoped by organization: another org's id is indistinguishable from a missing one.
  const user = await User.findOne({ _id: userId, organizationId: actor.organizationId }).lean();
  if (!user) throw Errors.notFound("User");
  return user;
}

async function deliverInvitation(actor: CurrentUser, user: { _id: Types.ObjectId; organizationId: Types.ObjectId; email: string; name: string }) {
  const issued = await issueToken({ userId: user._id, organizationId: user.organizationId, purpose: "invitation", createdBy: new Types.ObjectId(actor.id) });
  const message = invitationEmail({
    to: user.email,
    inviteeName: user.name,
    inviterName: actor.name,
    orgName: actor.organization.displayName,
    url: appLink("/accept-invitation", { token: issued.raw }),
    expiresHours: TOKEN_TTL_MS.invitation / 3_600_000,
  });
  try {
    await sendEmail(message);
    await recordDelivery(issued.tokenId, { ok: true });
    return { sent: true as const };
  } catch (err) {
    if (!(err instanceof EmailDeliveryError)) throw err;
    await recordDelivery(issued.tokenId, { ok: false, code: err.code });
    return { sent: false as const, code: err.code };
  }
}

/**
 * Creates an invited user and emails a single-use invitation. If the SMTP
 * server rejects the message, the user record remains (status "invited",
 * delivery "failed") and a 502 is returned so the UI can offer a retry.
 */
export async function inviteUser(actor: CurrentUser, input: z.infer<typeof inviteUserSchema>) {
  if (!actor.permissions.has("users:invite")) throw Errors.forbidden();
  if (!assignableRoles(actor.role).includes(input.role)) throw Errors.forbidden("You cannot assign that role.");
  getSmtpEnv(); // 503 setup error before anything is created
  await enforce([[RATE_LIMITS.inviteByActor, actor.id]]);
  await connectDb();

  const email = normalizeEmail(input.email);
  if (await User.exists({ email })) throw Errors.conflict("EMAIL_IN_USE", "A user with this email address already exists.");

  let user;
  try {
    user = await User.create({
      organizationId: actor.organizationId,
      email,
      name: input.name,
      role: input.role,
      status: "invited",
      permissionGrants: input.role === "STAFF" ? (input.permissionGrants ?? []) : [],
      invitedBy: actor.id,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw Errors.conflict("EMAIL_IN_USE", "A user with this email address already exists.");
    throw err;
  }

  const delivery = await deliverInvitation(actor, user);
  await recordAudit({
    organizationId: actor.organizationId,
    actorId: actor.id,
    action: "user.invited",
    entityType: "user",
    entityId: user._id,
    metadata: { role: input.role, emailSent: delivery.sent, ...(delivery.sent ? {} : { errorCode: delivery.code }) },
  });
  if (!delivery.sent) throw Errors.emailDelivery({ userId: String(user._id), errorCode: delivery.code });
  return { id: String(user._id), emailSent: true };
}

export async function resendInvitation(actor: CurrentUser, userId: string) {
  if (!actor.permissions.has("users:invite")) throw Errors.forbidden();
  getSmtpEnv();
  await enforce([[RATE_LIMITS.inviteByActor, actor.id]]);
  await connectDb();
  const user = await findOrgUser(actor, userId);
  if (!canManageRole(actor.role, user.role as Role)) throw Errors.forbidden();
  if (user.status !== "invited") throw Errors.conflict("NOT_INVITED", "Only users with a pending invitation can be re-invited.");
  const delivery = await deliverInvitation(actor, user);
  await recordAudit({
    organizationId: actor.organizationId,
    actorId: actor.id,
    action: "user.invitation_resent",
    entityType: "user",
    entityId: user._id,
    metadata: { emailSent: delivery.sent, ...(delivery.sent ? {} : { errorCode: delivery.code }) },
  });
  if (!delivery.sent) throw Errors.emailDelivery({ userId: String(user._id), errorCode: delivery.code });
  return { id: String(user._id), emailSent: true };
}

async function activeSuperadminCount(organizationId: Types.ObjectId | string) {
  return User.countDocuments({ organizationId, role: "SUPERADMIN", status: "active" });
}

/**
 * Role / status / grants / name changes with these rules:
 *  - cross-organization ids → 404
 *  - nobody changes their own role or status
 *  - ADMIN manages only STAFF/CLEANER and can only assign STAFF/CLEANER
 *  - the last active SUPERADMIN cannot be demoted or suspended (checked
 *    before the write, and re-checked after it with compensation, so two
 *    concurrent demotions cannot leave the organization without an owner)
 *  - role/status changes bump sessionVersion (immediate session revocation)
 */
export async function updateUser(actor: CurrentUser, userId: string, input: z.infer<typeof updateUserSchema>) {
  if (!actor.permissions.has("users:manage")) throw Errors.forbidden();
  await connectDb();
  const target = await findOrgUser(actor, userId);
  const isSelf = String(target._id) === actor.id;
  const currentRole = target.role as Role;
  const currentStatus = target.status as UserStatus;

  if (isSelf && (input.role !== undefined || input.status !== undefined || input.permissionGrants !== undefined)) {
    throw Errors.forbidden("You cannot change your own role, status or permissions.");
  }
  if (!canManageRole(actor.role, currentRole)) throw Errors.forbidden("You cannot manage this user.");
  if (input.role !== undefined && input.role !== currentRole && !assignableRoles(actor.role).includes(input.role)) {
    throw Errors.forbidden("You cannot assign that role.");
  }

  const nextRole = input.role ?? currentRole;
  let nextStatus: UserStatus = currentStatus;
  if (input.status === "suspended") nextStatus = "suspended";
  if (input.status === "active" && currentStatus === "suspended") {
    // A user who never accepted their invitation returns to "invited".
    const withHash = await User.findById(target._id).select("+passwordHash").lean();
    nextStatus = withHash?.passwordHash ? "active" : "invited";
  }

  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set.name = input.name;
  if (nextRole !== currentRole) set.role = nextRole;
  if (nextStatus !== currentStatus) set.status = nextStatus;
  if (input.permissionGrants !== undefined || nextRole !== currentRole) {
    set.permissionGrants = nextRole === "STAFF" ? (input.permissionGrants ?? target.permissionGrants ?? []) : [];
  }
  const accessChanged = set.role !== undefined || set.status !== undefined;
  if (Object.keys(set).length === 0) return { id: String(target._id), changed: false };

  const reducesOwners =
    currentRole === "SUPERADMIN" && currentStatus === "active" && (nextRole !== "SUPERADMIN" || nextStatus !== "active");
  if (reducesOwners && (await activeSuperadminCount(actor.organizationId)) <= 1) {
    throw Errors.conflict("LAST_SUPERADMIN", "The last active superadmin cannot be demoted or suspended.");
  }

  // Conditional on the values we read, so concurrent edits don't silently overwrite each other.
  const res = await User.updateOne(
    { _id: target._id, organizationId: actor.organizationId, role: currentRole, status: currentStatus },
    { $set: set, ...(accessChanged ? { $inc: { sessionVersion: 1 } } : {}) },
  );
  if (res.matchedCount === 0) throw Errors.conflict("CONCURRENT_CHANGE", "This user was changed by someone else. Reload and try again.");

  if (reducesOwners && (await activeSuperadminCount(actor.organizationId)) === 0) {
    await User.updateOne({ _id: target._id }, { $set: { role: currentRole, status: currentStatus, permissionGrants: target.permissionGrants ?? [] } });
    throw Errors.conflict("LAST_SUPERADMIN", "The last active superadmin cannot be demoted or suspended.");
  }

  const actions: string[] = [];
  if (set.role !== undefined) actions.push("user.role_changed");
  if (set.status !== undefined) actions.push(nextStatus === "suspended" ? "user.suspended" : "user.reactivated");
  if (set.permissionGrants !== undefined && set.role === undefined) actions.push("user.permissions_changed");
  if (set.name !== undefined) actions.push("user.profile_updated");
  for (const action of actions) {
    await recordAudit({
      organizationId: actor.organizationId,
      actorId: actor.id,
      action,
      entityType: "user",
      entityId: target._id,
      metadata: {
        ...(action === "user.role_changed" ? { from: currentRole, to: nextRole } : {}),
        ...(action === "user.suspended" || action === "user.reactivated" ? { from: currentStatus, to: nextStatus } : {}),
        ...(action === "user.permissions_changed" ? { grants: (set.permissionGrants as string[]) ?? [] } : {}),
      },
    });
  }
  return { id: String(target._id), changed: true };
}

export const updateProfileSchema = z.object({ name: z.string().trim().min(1, "Name is required.").max(120) }).strict();

export async function updateOwnProfile(actor: CurrentUser, input: z.infer<typeof updateProfileSchema>) {
  await connectDb();
  await User.updateOne({ _id: actor.id, organizationId: actor.organizationId }, { $set: { name: input.name } });
  await recordAudit({ organizationId: actor.organizationId, actorId: actor.id, action: "user.profile_updated", entityType: "user", entityId: actor.id });
  return { name: input.name };
}
