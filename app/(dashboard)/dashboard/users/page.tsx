import type { Metadata } from "next";
import { Search, UserCog } from "lucide-react";
import { AccessDenied } from "@/components/shell/access";
import { DeliveryBadge, RoleBadge, UserStatusBadge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Pagination } from "@/components/ui/pagination";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { ROLE_LABELS, ROLES, STATUS_LABELS, USER_STATUSES } from "@/lib/domain/constants";
import { formatDateTime } from "@/lib/domain/time";
import { assignableRoles, canManageRole, STAFF_GRANTABLE } from "@/lib/permissions/matrix";
import { listUsers, userListQuery } from "@/modules/users/service";
import { InviteUserButton, UserActions } from "./user-admin";

export const metadata: Metadata = { title: "Users" };

export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/users");
  if (!can(user, "users:read")) return <AccessDenied />;

  const raw = await searchParams;
  const flat = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v));
  const parsed = userListQuery.safeParse(flat);
  const query = parsed.success ? parsed.data : userListQuery.parse({});
  const result = await listUsers(user, query);
  const roles = assignableRoles(user.role);
  const tz = user.organization.timezone;
  const filtersActive = Boolean(query.q || query.role || query.status);

  return (
    <>
      <PageHeader
        title="Users"
        description="Invite teammates, assign roles and suspend access. Changes take effect on the user’s next request."
        actions={can(user, "users:invite") && roles.length > 0 ? <InviteUserButton roles={roles} grantable={STAFF_GRANTABLE} /> : null}
      />

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3 border-b border-line p-4" role="search" aria-label="Filter users">
          <label className="min-w-48 flex-1 text-sm">
            <span className="mb-1 block font-medium">Search</span>
            <span className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <input
                name="q"
                defaultValue={query.q ?? ""}
                placeholder="Name or email"
                maxLength={100}
                className="h-10 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-base sm:text-sm"
              />
            </span>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Role</span>
            <select name="role" defaultValue={query.role ?? ""} className="h-10 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
              <option value="">All roles</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Status</span>
            <select name="status" defaultValue={query.status ?? ""} className="h-10 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
              <option value="">All statuses</option>
              {USER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={buttonClasses("secondary", "sm", "h-10")}>
            Apply
          </button>
          {filtersActive ? (
            <a href="/dashboard/users" className={buttonClasses("ghost", "sm", "h-10")}>
              Clear
            </a>
          ) : null}
        </form>

        {result.items.length === 0 ? (
          <EmptyState icon={UserCog} title={filtersActive ? "No users match these filters" : "No users yet"}>
            {filtersActive ? "Try a different search or clear the filters." : "Invite your first teammate to get started."}
          </EmptyState>
        ) : (
          <>
          {/* Small screens: stacked cards (a wide table makes mobile browsers re-fit the viewport). */}
          <ul className="divide-y divide-line md:hidden" aria-label="Users">
            {result.items.map((u) => {
              const isSelf = u.id === user.id;
              const manageable = !isSelf && can(user, "users:manage") && canManageRole(user.role, u.role);
              return (
                <li key={u.id} className="space-y-2 px-4 py-4 text-sm">
                  <div>
                    <p className="font-medium">
                      {u.name} {isSelf ? <span className="text-xs font-normal text-muted">(you)</span> : null}
                    </p>
                    <p className="break-all text-muted">{u.email}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <RoleBadge role={u.role} />
                    <UserStatusBadge status={u.status} />
                    {u.invitation ? <DeliveryBadge status={u.invitation.status} expired={u.invitation.expired} /> : null}
                  </div>
                  <p className="text-xs text-muted">Last sign-in: {u.lastLoginAt ? formatDateTime(u.lastLoginAt, tz) : "Never"}</p>
                  {manageable ? <UserActions user={u} roles={roles} grantable={STAFF_GRANTABLE} canInvite={can(user, "users:invite")} /> : null}
                </li>
              );
            })}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Users in {user.organization.displayName}</caption>
              <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold">Name</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Role</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Status</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Last sign-in</th>
                  <th scope="col" className="px-5 py-3 text-right font-semibold">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.items.map((u) => {
                  const isSelf = u.id === user.id;
                  const manageable = !isSelf && can(user, "users:manage") && canManageRole(user.role, u.role);
                  return (
                    <tr key={u.id} className="align-top">
                      <td className="px-5 py-3">
                        <p className="font-medium">
                          {u.name} {isSelf ? <span className="text-xs font-normal text-muted">(you)</span> : null}
                        </p>
                        <p className="break-all text-muted">{u.email}</p>
                      </td>
                      <td className="px-3 py-3">
                        <RoleBadge role={u.role} />
                        {u.role === "STAFF" && u.permissionGrants.length > 0 ? (
                          <p className="mt-1 text-xs text-muted">+{u.permissionGrants.length} granted</p>
                        ) : null}
                      </td>
                      <td className="space-y-1 px-3 py-3">
                        <UserStatusBadge status={u.status} />
                        {u.invitation ? (
                          <div>
                            <DeliveryBadge status={u.invitation.status} expired={u.invitation.expired} />
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 text-muted">{u.lastLoginAt ? formatDateTime(u.lastLoginAt, tz) : "Never"}</td>
                      <td className="px-5 py-3 text-right">
                        {manageable ? (
                          <UserActions user={u} roles={roles} grantable={STAFF_GRANTABLE} canInvite={can(user, "users:invite")} />
                        ) : (
                          <span className="text-xs text-muted">{isSelf ? "Edit in Your account" : "No actions"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
        <Pagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          basePath="/dashboard/users"
          params={{ q: query.q, role: query.role, status: query.status }}
        />
      </Card>
    </>
  );
}
