import Link from "next/link";
import { MapPin } from "lucide-react";
import { formatCents } from "@/lib/domain/money";
import { formatDate } from "@/lib/domain/time";
import type { BookingDTO } from "@/modules/bookings/service";
import { BookingStatusBadge, UnassignedBadge } from "./status";

/** Readable booking cards/rows; every row links to the booking detail page. */
export function BookingList({ bookings, timezone, empty, showCustomer = true }: { bookings: BookingDTO[]; timezone: string; empty: string; showCustomer?: boolean }) {
  if (bookings.length === 0) return <p className="px-5 py-6 text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {bookings.map((b) => (
        <li key={b.id} className="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[10rem_1fr_auto] sm:gap-4">
          <div>
            <Link href={`/dashboard/bookings/${b.id}`} className="font-semibold underline-offset-4 hover:underline">
              {formatDate(b.scheduledStartAt, timezone)}
            </Link>
            <p className="tabular-nums text-muted">
              {b.local.startTime}–{b.local.endTime}
            </p>
          </div>
          <div className="min-w-0 space-y-0.5">
            {showCustomer ? <p className="font-medium">{b.customer.name}</p> : null}
            <p className="text-muted">{b.lineItems.map((l) => (l.quantity > 1 ? `${l.name} ×${l.quantity}` : l.name)).join(", ")}</p>
            <p className="flex items-start gap-1 text-muted">
              <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">{[b.address.line1, b.address.city].filter(Boolean).join(", ")}</span>
            </p>
            <p className="text-muted">{b.cleaners.length ? b.cleaners.map((c) => c.name).join(", ") : null}</p>
          </div>
          <div className="flex flex-wrap items-start gap-2 sm:flex-col sm:items-end">
            <BookingStatusBadge status={b.status} />
            {b.cleaners.length === 0 && b.status !== "CANCELLED" && b.status !== "COMPLETED" ? <UnassignedBadge /> : null}
            {b.subtotalCents !== null ? <span className="tabular-nums text-muted">{formatCents(b.subtotalCents, b.currency)}</span> : null}
            <span className="text-xs text-muted">{b.reference}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
