"use client";

import dynamic from "next/dynamic";

/** FullCalendar is client-only and heavy: load it lazily, never on the server. */
const CalendarView = dynamic(() => import("./calendar-view"), {
  ssr: false,
  loading: () => (
    <div role="status" className="h-96 animate-pulse rounded-xl border border-line bg-surface">
      <span className="sr-only">Loading calendar…</span>
    </div>
  ),
});

export function CalendarShell(props: { timezone: string; cleaners: { id: string; name: string }[]; canCreate: boolean; initialDate?: string; initialView?: string }) {
  return <CalendarView {...props} />;
}
