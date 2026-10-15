"use client";

import { CalendarClock } from "lucide-react";
import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/client/api";

type Busy = { start: string; end: string };

function minutesOfDay(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/**
 * Advisory only: busy periods in the connected Google calendar for the chosen
 * day (times only, no event details). Renders nothing when Google Calendar is
 * not connected. The CRM's own conflict check still decides.
 */
export function GoogleBusyNote({ date, startTime, durationMinutes, timeZone }: { date: string; startTime: string; durationMinutes: number; timeZone: string }) {
  const [state, setState] = useState<{ date: string; busy: Busy[]; unavailable?: boolean } | null>(null);
  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      void apiRequest<{ connected: boolean; busy: Busy[]; unavailable?: boolean }>(`/api/v1/integrations/google/busy?date=${date}`, { signal: ctrl.signal }).then((r) => {
        if (r.ok && r.data.connected) setState({ date, busy: r.data.busy, unavailable: r.data.unavailable });
        else if (r.ok || r.status !== 0) setState(null);
      });
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [date]);
  if (!state || state.date !== date) return null;
  if (state.unavailable) return <p className="text-xs text-muted">Google Calendar busy times could not be checked right now.</p>;
  if (!state.busy.length) return <p className="flex items-center gap-1 text-xs text-muted"><CalendarClock className="size-3.5" aria-hidden /> No other busy times in Google Calendar that day.</p>;
  const [h, m] = startTime.split(":").map(Number);
  const from = (h ?? 0) * 60 + (m ?? 0);
  const to = from + (durationMinutes || 0);
  const fmt = (iso: string) => new Date(iso).toLocaleTimeString("en-CA", { timeZone, hour: "numeric", minute: "2-digit" });
  const rows = state.busy.map((b) => {
    const s = minutesOfDay(b.start, timeZone);
    const e = Math.max(minutesOfDay(b.end, timeZone), s + 1);
    return { ...b, overlaps: Number.isFinite(from) && s < to && e > from };
  });
  const clash = rows.some((r) => r.overlaps);
  return (
    <div role={clash ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${clash ? "border-pending/40 bg-pending-soft" : "border-line bg-canvas"}`}>
      <p className="flex items-center gap-1 font-medium">
        <CalendarClock className="size-4" aria-hidden /> {clash ? "This time overlaps a busy period in Google Calendar" : "Busy in Google Calendar that day"}
      </p>
      <p className="text-muted">{rows.map((r) => `${fmt(r.start)}–${fmt(r.end)}${r.overlaps ? " (overlaps)" : ""}`).join(" · ")}</p>
      <p className="text-xs text-muted">A warning only — you can still save.</p>
    </div>
  );
}
