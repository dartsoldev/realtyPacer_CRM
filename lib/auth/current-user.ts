import "server-only";
import { cache } from "react";
import { isValidObjectId } from "mongoose";
import { connectDb } from "@/lib/db/connect";
import { Organization } from "@/lib/db/models/organization";
import { User } from "@/lib/db/models/user";
import type { Role } from "@/lib/domain/constants";
import { Errors } from "@/lib/http/errors";
import { permissionsFor, type Permission } from "@/lib/permissions/matrix";
import { getSessionClaims, type SessionClaims } from "./claims";

export type CurrentUser = {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: Role;
  permissionGrants: string[];
  permissions: Set<Permission>;
  organization: {
    id: string;
    displayName: string;
    timezone: string;
    currency: string;
    terminology: { customer: string; booking: string; provider: string };
  };
};

export type SessionCheck = { user: CurrentUser } | { user: null; reason: "no_session" | "revoked" };

/**
 * Validates session claims against the database on every request:
 * the user must exist, be active, have a verified email, still belong to the
 * same organization, and have an unchanged sessionVersion. Role and
 * permissions come from the database, so changes apply immediately.
 */
export async function resolveUser(claims: SessionClaims | null): Promise<SessionCheck> {
  if (!claims) return { user: null, reason: "no_session" };
  if (!isValidObjectId(claims.userId)) return { user: null, reason: "revoked" };
  await connectDb();
  const user = await User.findById(claims.userId).lean();
  if (
    !user ||
    user.status !== "active" ||
    !user.emailVerifiedAt ||
    user.sessionVersion !== claims.sessionVersion ||
    String(user.organizationId) !== claims.organizationId
  ) {
    return { user: null, reason: "revoked" };
  }
  const org = await Organization.findById(user.organizationId).lean();
  if (!org) return { user: null, reason: "revoked" };
  const role = user.role as Role;
  return {
    user: {
      id: String(user._id),
      organizationId: String(user.organizationId),
      email: user.email,
      name: user.name,
      role,
      permissionGrants: user.permissionGrants ?? [],
      permissions: permissionsFor(role, user.permissionGrants ?? []),
      organization: {
        id: String(org._id),
        displayName: org.displayName,
        timezone: org.timezone,
        currency: org.currency,
        terminology: {
          customer: org.terminology?.customer ?? "Customer",
          booking: org.terminology?.booking ?? "Booking",
          provider: org.terminology?.provider ?? "Cleaner",
        },
      },
    },
  };
}

/** Request-scoped (deduplicated per render) session check. */
export const checkSession = cache(async (): Promise<SessionCheck> => resolveUser(await getSessionClaims()));

export async function getCurrentUser(): Promise<CurrentUser | null> {
  return (await checkSession()).user;
}

export function can(user: CurrentUser, permission: Permission): boolean {
  return user.permissions.has(permission);
}

/** For route handlers: throws 401/403 AppErrors. */
export async function requireApiUser(permission?: Permission): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw Errors.unauthenticated();
  if (permission && !can(user, permission)) throw Errors.forbidden();
  return user;
}
