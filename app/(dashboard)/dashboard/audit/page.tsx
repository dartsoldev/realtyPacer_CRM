import type { Metadata } from "next";
import { ScrollText } from "lucide-react";
import { AccessDenied } from "@/components/shell/access";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { Pagination } from "@/components/ui/pagination";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { formatDateTime } from "@/lib/domain/time";
import { auditListQuery, listAuditEvents } from "@/modules/audit/service";

export const metadata: Metadata = { title: "Audit history" };

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in attempt",
  "auth.password_changed": "Changed password",
  "auth.password_reset_requested": "Requested password reset",
  "auth.password_reset_completed": "Reset password",
  "auth.email_verified": "Verified email",
  "user.invited": "Invited user",
  "user.invitation_resent": "Resent invitation",
  "user.invitation_accepted": "Accepted invitation",
  "user.role_changed": "Changed role",
  "user.suspended": "Suspended user",
  "user.reactivated": "Reactivated user",
  "user.permissions_changed": "Changed staff permissions",
  "user.profile_updated": "Updated profile",
  "organization.updated": "Updated organization settings",
  "email.delivery_failed": "Email delivery failed",
  "bootstrap.superadmin_created": "First superadmin created (CLI)",
};

function describe(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof meta.from === "string" && typeof meta.to === "string") parts.push(`${meta.from} → ${meta.to}`);
  if (typeof meta.role === "string") parts.push(`role ${meta.role}`);
  if (meta.emailSent === false) parts.push("email not sent");
  if (meta.emailSent === true) parts.push("email accepted by mail server");
  if (typeof meta.code === "string") parts.push(`code ${meta.code}`);
  if (typeof meta.errorCode === "string") parts.push(`code ${meta.errorCode}`);
  if (typeof meta.kind === "string") parts.push(meta.kind.replace(/_/g, " "));
  if (Array.isArray(meta.fields)) parts.push(`fields: ${meta.fields.join(", ")}`);
  if (Array.isArray(meta.grants)) parts.push(meta.grants.length ? `grants: ${meta.grants.join(", ")}` : "grants cleared");
  return parts.join(" · ");
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/audit");
  if (!can(user, "audit:read")) return <AccessDenied />;
  const sp = await searchParams;
  const parsed = auditListQuery.safeParse({ page: typeof sp.page === "string" ? sp.page : undefined });
  const result = await listAuditEvents(user, parsed.success ? parsed.data : auditListQuery.parse({}));
  const tz = user.organization.timezone;

  return (
    <>
      <PageHeader title="Audit history" description={`Administrative and security events, newest first. Times shown in ${tz}.`} />
      <Card>
        {result.items.length === 0 ? (
          <EmptyState icon={ScrollText} title="No events recorded yet" />
        ) : (
          <>
          <ul className="divide-y divide-line md:hidden" aria-label="Audit events">
            {result.items.map((e) => (
              <li key={e.id} className="space-y-1 px-4 py-3 text-sm">
                <p className="font-medium">{ACTION_LABELS[e.action] ?? e.action}</p>
                <p className="text-muted">
                  {e.actor?.name ?? "System / anonymous"} · <time dateTime={e.createdAt}>{formatDateTime(e.createdAt, tz)}</time>
                </p>
                {describe(e.metadata) ? <p className="text-xs text-muted">{describe(e.metadata)}</p> : null}
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Audit events</caption>
              <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-5 py-3 font-semibold">When</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Who</th>
                  <th scope="col" className="px-3 py-3 font-semibold">Event</th>
                  <th scope="col" className="px-5 py-3 font-semibold">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.items.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap px-5 py-3 text-muted">
                      <time dateTime={e.createdAt}>{formatDateTime(e.createdAt, tz)}</time>
                    </td>
                    <td className="px-3 py-3">{e.actor?.name ?? <span className="text-muted">System / anonymous</span>}</td>
                    <td className="px-3 py-3 font-medium">{ACTION_LABELS[e.action] ?? e.action}</td>
                    <td className="px-5 py-3 text-muted">{describe(e.metadata) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
        <Pagination page={result.page} totalPages={result.totalPages} total={result.total} basePath="/dashboard/audit" />
      </Card>
    </>
  );
}
