import type { Metadata } from "next";
import { CalendarPlus } from "lucide-react";
import { CalendarShell } from "@/components/ops/calendar-shell";
import { AccessDenied } from "@/components/shell/access";
import { LinkButton } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { isDateKey } from "@/lib/domain/zoned-time";
import { listCleaners } from "@/modules/cleaners/service";

export const metadata: Metadata = { title: "Calendar" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/calendar");
  if (!can(user, "calendar:read")) return <AccessDenied />;
  const sp = await searchParams;
  const initialDate = typeof sp.date === "string" && isDateKey(sp.date) ? sp.date : undefined;
  const initialView = typeof sp.view === "string" && ["dayGridMonth", "timeGridWeek", "timeGridDay", "listWeek"].includes(sp.view) ? sp.view : undefined;
  const cleaners = can(user, "cleaners:read") ? (await listCleaners(user, { status: "all", page: 1, pageSize: 100 })).items.map((c) => ({ id: c.id, name: c.name })) : [];
  return (
    <>
      <PageHeader
        title="Calendar"
        description={`All times in ${user.organization.timezone}. Only the visible range is loaded.`}
        actions={
          can(user, "bookings:write") ? (
            <LinkButton href="/dashboard/bookings/new">
              <CalendarPlus className="size-4" aria-hidden /> New booking
            </LinkButton>
          ) : null
        }
      />
      <CalendarShell timezone={user.organization.timezone} cleaners={cleaners} canCreate={can(user, "bookings:write")} initialDate={initialDate} initialView={initialView} />
    </>
  );
}
