"use client";

import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin, { type DateClickArg } from "@fullcalendar/interaction";
import listPlugin from "@fullcalendar/list";
import timeGridPlugin from "@fullcalendar/timegrid";
import type { EventClickArg, EventContentArg, EventInput, EventSourceFuncArg } from "@fullcalendar/core";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { apiRequest } from "@/lib/client/api";
import { BOOKING_STATUS_LABELS, BOOKING_STATUSES, type BookingStatus } from "@/lib/domain/constants";
import { addDaysToKey, localDateKey, localTimeKey } from "@/lib/domain/zoned-time";
import type { CalendarEvent } from "@/modules/bookings/service";

/**
 * The calendar runs in FullCalendar's "UTC" zone and receives organization
 * wall-clock times without offsets, so every view shows the organization's
 * local time (e.g. America/Toronto) regardless of the viewer's browser zone.
 * Clicked dates are read back the same way and sent as local date/time.
 */
const COLORS: Record<BookingStatus, { bg: string; border: string; text: string }> = {
  SCHEDULED: { bg: "#EFF6FF", border: "#1D4ED8", text: "#1E3A8A" },
  IN_PROGRESS: { bg: "#FFFBEB", border: "#B45309", text: "#78350F" },
  COMPLETED: { bg: "#F0FDF4", border: "#15803D", text: "#14532D" },
  CANCELLED: { bg: "#FEF2F2", border: "#B91C1C", text: "#7F1D1D" },
};

const utcKey = (d: Date) => d.toISOString().slice(0, 10);

export default function CalendarView({
  timezone,
  cleaners,
  canCreate,
  initialDate,
  initialView,
}: {
  timezone: string;
  cleaners: { id: string; name: string }[];
  canCreate: boolean;
  initialDate?: string;
  initialView?: string;
}) {
  const router = useRouter();
  const ref = useRef<FullCalendar>(null);
  const [cleanerId, setCleanerId] = useState("");
  const [status, setStatus] = useState("");
  const [city, setCity] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Read by the event source (outside render); kept in sync by the filter handlers.
  const filters = useRef({ cleanerId: "", status: "", city: "" });
  const isNarrow = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;

  const fetchEvents = useMemo(
    () => async (arg: EventSourceFuncArg): Promise<EventInput[]> => {
      const sp = new URLSearchParams({ start: utcKey(arg.start), end: addDaysToKey(utcKey(arg.end), -1) });
      const f = filters.current;
      if (f.cleanerId) sp.set("cleanerId", f.cleanerId);
      if (f.status) sp.set("status", f.status);
      if (f.city.trim()) sp.set("city", f.city.trim());
      const res = await apiRequest<{ events: CalendarEvent[] }>(`/api/v1/calendar/events?${sp}`);
      if (!res.ok) {
        setError(res.message);
        throw new Error(res.message);
      }
      setError(null);
      return res.data.events.map((e) => ({
        id: e.id,
        title: e.title,
        start: e.start,
        end: e.end,
        url: bookingHref(e.id),
        backgroundColor: COLORS[e.status].bg,
        borderColor: COLORS[e.status].border,
        textColor: COLORS[e.status].text,
        extendedProps: e,
      }));
    },
    [],
  );

  // Current date/view, kept in the URL so “Back to calendar” returns to the same place.
  const position = useRef({ date: initialDate ?? "", view: initialView ?? "" });
  function bookingHref(id: string) {
    const sp = new URLSearchParams({ from: "calendar" });
    if (position.current.date) sp.set("date", position.current.date);
    if (position.current.view) sp.set("view", position.current.view);
    return `/dashboard/bookings/${id}?${sp}`;
  }

  function refetch() {
    ref.current?.getApi().refetchEvents();
  }

  function renderEvent(arg: EventContentArg) {
    const e = arg.event.extendedProps as CalendarEvent;
    return (
      <div className="overflow-hidden px-0.5 text-xs leading-snug" style={{ color: COLORS[e.status].text }}>
        <span className="font-semibold">{arg.timeText} </span>
        <span className="font-semibold">{e.title}</span>
        <span className="block">[{BOOKING_STATUS_LABELS[e.status]}]</span>
        {e.services ? <span className="block truncate">{e.services}</span> : null}
        {e.city ? <span className="block truncate">{e.city}</span> : null}
        <span className="block truncate">{e.cleaners.length ? e.cleaners.join(", ") : "Unassigned"}</span>
      </div>
    );
  }

  const nowWall = () => {
    const now = new Date();
    return `${localDateKey(now, timezone)}T${localTimeKey(now, timezone)}:00`;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block font-medium">Cleaner</span>
          <select value={cleanerId} onChange={(e) => { setCleanerId(e.target.value); filters.current.cleanerId = e.target.value; refetch(); }} className="h-10 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
            <option value="">Everyone</option>
            {cleaners.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium">Status</span>
          <select value={status} onChange={(e) => { setStatus(e.target.value); filters.current.status = e.target.value; refetch(); }} className="h-10 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
            <option value="">Any status</option>
            {BOOKING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {BOOKING_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            refetch();
          }}
        >
          <label className="text-sm">
            <span className="mb-1 block font-medium">Booked city</span>
            <input value={city} onChange={(e) => { setCity(e.target.value); filters.current.city = e.target.value; }} maxLength={100} className="h-10 w-36 rounded-lg border border-line bg-surface px-3 text-base sm:text-sm" />
          </label>
          <button type="submit" className="h-10 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-canvas">
            Apply
          </button>
        </form>
        <ul className="ml-auto flex flex-wrap gap-3 text-xs" aria-label="Status colours">
          {BOOKING_STATUSES.map((s) => (
            <li key={s} className="flex items-center gap-1">
              <span className="inline-block size-3 rounded-sm border" style={{ background: COLORS[s].bg, borderColor: COLORS[s].border }} aria-hidden />
              {BOOKING_STATUS_LABELS[s]}
            </li>
          ))}
        </ul>
      </div>
      {error ? <Alert tone="danger" title="Bookings couldn’t be loaded">{error}</Alert> : null}
      <div className="rp-calendar rounded-xl border border-line bg-surface p-2 sm:p-4">
        <FullCalendar
          ref={ref}
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
          timeZone="UTC"
          now={nowWall}
          initialView={initialView ?? (isNarrow ? "listWeek" : "timeGridWeek")}
          datesSet={(arg) => {
            const date = utcKey(arg.view.calendar.getDate());
            position.current = { date, view: arg.view.type };
            window.history.replaceState(null, "", `/dashboard/calendar?date=${date}&view=${arg.view.type}`);
          }}
          initialDate={initialDate}
          headerToolbar={isNarrow ? { left: "prev,next", center: "title", right: "today" } : { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,timeGridDay,listWeek" }}
          footerToolbar={isNarrow ? { center: "listWeek,timeGridDay,dayGridMonth" } : undefined}
          buttonText={{ today: "Today", month: "Month", week: "Week", day: "Day", list: "Agenda" }}
          firstDay={0}
          height={isNarrow ? "auto" : 760}
          scrollTime="07:00:00"
          slotDuration="00:30:00"
          nowIndicator
          eventTimeFormat={{ hour: "numeric", minute: "2-digit", meridiem: "short" }}
          dayMaxEvents={3}
          navLinks
          events={fetchEvents}
          eventContent={renderEvent}
          eventClick={(arg: EventClickArg) => {
            arg.jsEvent.preventDefault();
            router.push(bookingHref(arg.event.id));
          }}
          dateClick={
            canCreate
              ? (arg: DateClickArg) => {
                  const date = arg.dateStr.slice(0, 10);
                  const time = arg.allDay ? "09:00" : arg.dateStr.slice(11, 16);
                  router.push(`/dashboard/bookings/new?date=${date}&time=${time}`);
                }
              : undefined
          }
          noEventsText="No bookings in this period."
        />
      </div>
      {canCreate ? <p className="text-xs text-muted">Click an empty time or day to start a booking there, or use “New booking”. Every booking in the calendar is a link you can reach with the keyboard.</p> : null}
    </div>
  );
}
