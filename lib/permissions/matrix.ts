import type { Role } from "@/lib/domain/constants";

/**
 * Server-side permission matrix. Safe to import on the client for *display*
 * decisions (e.g. hiding nav links) — but every route, page loader and
 * mutation re-checks on the server with the user's current DB role.
 */
export const PERMISSIONS = [
  "dashboard:view",
  "account:self",
  // Operational modules (phases 2–3)
  "customers:read",
  "customers:write",
  "services:read",
  "services:write",
  "bookings:read",
  "bookings:write",
  "bookings:read_assigned",
  /** Start/complete jobs the user's linked cleaner record is assigned to. */
  "bookings:transition_assigned",
  /** Reopen a completed job (audited, with a reason). */
  "bookings:reopen",
  /** Change a line item's unit price away from the catalog price (audited). */
  "bookings:price_override",
  /** See prices, line totals and subtotals. Without it, amounts are not sent to the browser. */
  "pricing:read",
  /** Add notes and call outcomes to customers/bookings. */
  "activities:write",
  "calendar:read",
  "cleaners:read",
  "cleaners:write",
  "payments:read",
  "payments:write",
  "reports:read",
  "customFields:manage",
  "loyalty:read",
  "loyalty:write",
  // Administration
  "users:read",
  "users:invite",
  "users:manage",
  "organization:read",
  "organization:update",
  "organization:update_protected",
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const OPERATIONAL: Permission[] = [
  "customers:read",
  "customers:write",
  "services:read",
  "services:write",
  "bookings:read",
  "bookings:write",
  "calendar:read",
  "cleaners:read",
  "cleaners:write",
  "payments:read",
  "payments:write",
  "reports:read",
  "customFields:manage",
  "loyalty:read",
  "loyalty:write",
  "pricing:read",
  "bookings:price_override",
  "activities:write",
];

/** Permissions every STAFF user has without explicit grants. */
export const STAFF_BASE: Permission[] = [
  "dashboard:view",
  "account:self",
  "customers:read",
  "services:read",
  "bookings:read",
  "calendar:read",
  "activities:write",
];

/** Operational permissions an admin may explicitly grant to STAFF. */
export const STAFF_GRANTABLE: Permission[] = [
  "customers:write",
  "services:write",
  "bookings:write",
  "pricing:read",
  "bookings:price_override",
  "cleaners:read",
  "cleaners:write",
  "payments:read",
  "payments:write",
  "reports:read",
  "loyalty:read",
  "loyalty:write",
];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPERADMIN: PERMISSIONS,
  ADMIN: [
    "dashboard:view",
    "account:self",
    ...OPERATIONAL,
    "bookings:reopen",
    "users:read",
    "users:invite",
    "users:manage",
    "organization:read",
    "organization:update",
  ],
  STAFF: STAFF_BASE,
  // Only their own assigned jobs; no customer directory, pricing or office notes.
  CLEANER: ["dashboard:view", "account:self", "bookings:read_assigned", "bookings:transition_assigned"],
};

export function permissionsFor(role: Role, grants: readonly string[] = []): Set<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  if (role === "STAFF") {
    for (const g of grants) if ((STAFF_GRANTABLE as string[]).includes(g)) set.add(g as Permission);
  }
  return set;
}

export function hasPermission(role: Role, grants: readonly string[], permission: Permission): boolean {
  return permissionsFor(role, grants).has(permission);
}

/** Roles that `actorRole` may assign (on invite or role change). */
export function assignableRoles(actorRole: Role): Role[] {
  if (actorRole === "SUPERADMIN") return ["SUPERADMIN", "ADMIN", "STAFF", "CLEANER"];
  if (actorRole === "ADMIN") return ["STAFF", "CLEANER"];
  return [];
}

/** Whether `actorRole` may manage (change role/status/grants of) a user currently holding `targetRole`. */
export function canManageRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole === "SUPERADMIN") return true;
  if (actorRole === "ADMIN") return targetRole === "STAFF" || targetRole === "CLEANER";
  return false;
}

/** Organization fields only a SUPERADMIN may change. */
export const PROTECTED_ORGANIZATION_FIELDS = ["name", "currency", "timezone"] as const;
