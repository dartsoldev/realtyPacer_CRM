import type { Metadata } from "next";
import Link from "next/link";
import { Bell } from "lucide-react";
import { MarkAllReadButton } from "@/components/shell/notification-actions";
import { Badge } from "@/components/ui/badge";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";
import { requirePageUser } from "@/lib/auth/page-guard";
import { formatDateTime } from "@/lib/domain/time";
import { listNotifications } from "@/modules/notifications/service";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/notifications");
  const page = Math.max(1, Math.min(100, Number((await searchParams).page) || 1));
  const data = await listNotifications(user, page);
  const tz = user.organization.timezone;
  return (
    <>
      <PageHeader title="Notifications" description="Job assignments and changes that concern you. Opening a job always re-checks your access." actions={data.unread ? <MarkAllReadButton /> : null} />
      <Card>
        {data.items.length === 0 ? (
          <EmptyState icon={Bell} title="No notifications yet">You’ll see new job assignments, removals, time changes and cancellations here.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {data.items.map((n) => (
              <li key={n.id} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">
                    {!n.read ? <Badge tone="info" className="mr-2">New</Badge> : null}
                    {n.href && n.type !== "assignment_removed" ? <Link href={n.href} className="underline-offset-4 hover:underline">{n.title}</Link> : n.title}
                  </p>
                  <p className="text-muted">{n.body}</p>
                </div>
                <time dateTime={n.createdAt} className="text-xs text-muted">{formatDateTime(n.createdAt, tz)}</time>
              </li>
            ))}
          </ul>
        )}
        {data.totalPages > 1 ? (
          <nav aria-label="Pagination" className="flex justify-between border-t border-line px-5 py-3 text-sm">
            {page > 1 ? <Link href={`/dashboard/notifications?page=${page - 1}`} className="underline">Newer</Link> : <span />}
            {page < data.totalPages ? <Link href={`/dashboard/notifications?page=${page + 1}`} className="underline">Older</Link> : null}
          </nav>
        ) : null}
      </Card>
    </>
  );
}
