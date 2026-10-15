import Link from "next/link";
import { MapPin } from "lucide-react";
import { BookingActions } from "./booking-actions";
import { CallActions } from "@/components/calls/call-actions";
import { MapLink } from "./contact";
import { BookingStatusBadge } from "./status";
import { formatDate } from "@/lib/domain/time";
import type { BookingDTO } from "@/modules/bookings/service";

/** Mobile-first job cards for cleaners: only what's needed to do the job. */
export function JobCards({ jobs, timezone }: { jobs: BookingDTO[]; timezone: string }) {
  return (
    <ul className="space-y-4">
      {jobs.map((j) => (
        <li key={j.id} className="space-y-3 rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <Link href={`/dashboard/bookings/${j.id}`} className="text-base font-semibold underline-offset-4 hover:underline">
                {formatDate(j.scheduledStartAt, timezone)} · <span className="tabular-nums">{j.local.startTime}–{j.local.endTime}</span>
              </Link>
              <p className="text-sm text-muted">{j.reference}</p>
            </div>
            <BookingStatusBadge status={j.status} />
          </div>
          <div className="space-y-1 text-sm">
            <p className="font-medium">{j.customer.name}</p>
            <CallActions e164={j.customer.phone} display={j.customer.phoneDisplay} target={{ type: "customer", id: j.customer.id, name: j.customer.name, bookingId: j.id }} canLog={false} browserCalling={false} />
          </div>
          <div className="space-y-1 text-sm">
            <p className="flex items-start gap-1">
              <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              <span>{[j.address.line1, j.address.line2, j.address.city].filter(Boolean).join(", ")}</span>
            </p>
            <MapLink href={j.address.mapUrl} />
            {j.address.accessInstructions ? <p className="rounded-md bg-canvas p-2"><span className="font-medium">Access: </span>{j.address.accessInstructions}</p> : null}
          </div>
          <p className="text-sm">
            <span className="font-medium">Services: </span>
            {j.lineItems.map((l) => `${l.name} ×${l.quantity}`).join(", ")}
          </p>
          {j.instructions ? <p className="whitespace-pre-wrap text-sm"><span className="font-medium">Instructions: </span>{j.instructions}</p> : null}
          <BookingActions bookingId={j.id} version={j.version} actions={j.allowedActions} />
        </li>
      ))}
    </ul>
  );
}
