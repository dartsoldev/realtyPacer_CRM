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
  /** View payments, refunds, balances, credit and money in reports. */
  "financials:read",
  /** Record received payments (manual entry). */
  "payments:record",
  /** Apply a customer's unallocated credit to finalized charges. */
  "payments:allocate",
  /** Record refunds processed outside RealtyPacer, and reverse mistaken receipts. */
  "payments:refund",
  /** Finalize booking charges (creates the amount owed) and set draft discounts. */
  "billing:finalize",
  /** Credit or add to finalized charges with a reason (append-only adjustments). */
  "billing:adjust",
  "reports:read",
  "reports:export",
  /** Share saved views with the whole organization. */
  "views:share",
  "customFields:manage",
  "loyalty:read",
  /** Grant, redeem, correct and reverse loyalty points. */
  "loyalty:adjust",
  /** Log calls (phone app or browser) against customers, cleaners and bookings. */
  "calls:log",
  /** Place outbound calls from the browser (when CALLING_MODE=browser is configured). Costs money. */
  "calls:browser",
  /** Send optional booking confirmation / change emails to customers. */
  "bookings:notify",
  /** Import customers from CSV. */
  "customers:import",
  /** View property/booking photos and documents (office). */
  "attachments:read",
  /** Upload property/booking photos and documents (office). */
  "attachments:write",
  /** Remove any attachment (office). Uploaders may always remove their own. */
  "attachments:delete",
  /** Cleaners: view and add photos on bookings they are assigned to. */
  "attachments:assigned",
  /** Operational diagnostics: outbox, background jobs, configuration status. */
  "system:diagnostics",
  /** View leads (general/service and real estate). */
  "leads:read",
  /** Create, edit, assign and convert leads; import lead CSVs. */
  "leads:write",
  /** Connect/disconnect Google Calendar and manage lead intake sources (credentials stay server-side). */
  "integrations:manage",
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
  "financials:read",
  "payments:record",
  "payments:allocate",
  "payments:refund",
  "billing:finalize",
  "billing:adjust",
  "reports:read",
  "reports:export",
  "views:share",
  "customFields:manage",
  "loyalty:read",
  "loyalty:adjust",
  "pricing:read",
  "bookings:price_override",
  "activities:write",
  "calls:log",
  "calls:browser",
  "bookings:notify",
  "customers:import",
  "attachments:read",
  "attachments:write",
  "attachments:delete",
  "leads:read",
  "leads:write",
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
  "calls:log",
  "attachments:read",
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
  "financials:read",
  "payments:record",
  "payments:allocate",
  "payments:refund",
  "billing:finalize",
  "billing:adjust",
  "reports:read",
  "reports:export",
  "views:share",
  "loyalty:read",
  "loyalty:adjust",
  "calls:browser",
  "bookings:notify",
  "customers:import",
  "attachments:write",
  "attachments:delete",
  "leads:read",
  "leads:write",
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
    "system:diagnostics",
    "integrations:manage",
  ],
  STAFF: STAFF_BASE,
  // Only their own assigned jobs; no customer directory, pricing or office notes.
  CLEANER: ["dashboard:view", "account:self", "bookings:read_assigned", "bookings:transition_assigned", "attachments:assigned"],
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
