"use client";

import { MessageSquare, PhoneCall } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/client/api";
import { CALL_OUTCOME_LABELS } from "@/lib/domain/constants";
import { formatDateTime } from "@/lib/domain/time";
import type { ActivityItem } from "@/modules/activities/service";

const LABELS: Record<string, string> = {
  "customer.created": "Customer created",
  "customer.updated": "Customer details updated",
  "customer.archived": "Customer archived",
  "customer.unarchived": "Customer restored",
  "address.added": "Address added",
  "address.updated": "Address updated",
  "address.archived": "Address archived",
  "booking.created": "Booking created",
  "booking.updated": "Booking updated",
  "booking.rescheduled": "Booking rescheduled",
  "booking.address_changed": "Booking address changed",
  "booking.assignment_changed": "Cleaner assignment changed",
  "booking.started": "Job started",
  "booking.completed": "Job completed",
  "booking.cancelled": "Booking cancelled",
  "booking.reopened": "Job reopened",
  "charges.discount_set": "Discount changed",
  "charges.finalized": "Charges finalized",
  "charges.adjusted": "Charge adjusted",
  "payment.recorded": "Payment recorded",
  "credit.applied": "Credit applied",
  "payment.refunded": "Refund recorded",
  "payment.reversed": "Payment reversed",
  "points.changed": "Loyalty points changed",
  note: "Note",
  call: "Call logged",
};

function detail(a: ActivityItem, tz: string): string {
  const m = a.metadata;
  const parts: string[] = [];
  if (typeof m.reference === "string") parts.push(m.reference);
  if (typeof m.from === "string" && typeof m.to === "string") {
    const isDate = /^\d{4}-\d{2}-\d{2}T/.test(m.from);
    parts.push(isDate ? `${formatDateTime(m.from, tz)} → ${formatDateTime(m.to, tz)}` : `${m.from} → ${m.to}`);
  }
  if (Array.isArray(m.fields) && m.fields.length) parts.push(`changed: ${m.fields.join(", ")}`);
  if (typeof m.label === "string") parts.push(m.label);
  if (a.type === "call") {
    if (typeof m.targetName === "string") parts.push(`${m.direction === "inbound" ? "from" : "to"} ${m.targetName}`);
    if (m.channel === "browser") parts.push("browser call");
    if (typeof m.durationSeconds === "number" && m.durationSeconds > 0) parts.push(`${Math.max(1, Math.round(m.durationSeconds / 60))} min`);
  }
  return parts.join(" · ");
}

/**
 * Office-only timeline with manual notes and call outcomes. Clicking a phone
 * link never logs a call; staff record the outcome here explicitly.
 */
export function ActivityFeed({ customerId, bookingId, canWrite, timezone }: { customerId?: string; bookingId?: string; canWrite: boolean; timezone: string }) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const scope = customerId ? `customerId=${customerId}` : `bookingId=${bookingId}`;
  const load = useCallback(
    async (p: number, replace: boolean) => {
      setLoading(true);
      const res = await apiRequest<{ items: ActivityItem[]; totalPages: number }>(`/api/v1/activities?${scope}&page=${p}&pageSize=20`);
      setLoading(false);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setError(null);
      setItems((prev) => (replace ? res.data.items : [...prev, ...res.data.items]));
      setTotalPages(res.data.totalPages);
      setPage(p);
    },
    [scope],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch of client-side feed
    void load(1, true);
    // Other components (e.g. "Log call") announce new timeline entries.
    const reload = () => void load(1, true);
    window.addEventListener("rp:activity-changed", reload);
    return () => window.removeEventListener("rp:activity-changed", reload);
  }, [load]);

  async function add() {
    setSaving(true);
    setFormError(null);
    const res = await apiRequest("/api/v1/activities", {
      method: "POST",
      body: { ...(customerId ? { customerId } : { bookingId }), kind: "note", content },
    });
    setSaving(false);
    if (!res.ok) {
      setFormError(res.fieldErrors ? Object.values(res.fieldErrors)[0]?.[0] ?? res.message : res.message);
      return;
    }
    setContent("");
    void load(1, true);
  }

  return (
    <div className="space-y-4">
      {canWrite ? (
        <form
          className="space-y-3 rounded-xl border border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Note</span>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={2} maxLength={2000} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm" />
          </label>
          {formError ? <p className="text-sm text-danger" role="alert">{formError}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">To record a phone call, use “Log call” next to the phone number.</p>
            <Button type="submit" size="sm" loading={saving}>
              Add to history
            </Button>
          </div>
        </form>
      ) : null}

      {error ? <Alert tone="danger" title="History couldn’t be loaded">{error}</Alert> : null}
      {!loading && !error && items.length === 0 ? <p className="text-sm text-muted">No activity yet.</p> : null}
      <ol className="space-y-3" aria-busy={loading}>
        {items.map((a) => (
          <li key={a.id} className="flex gap-3 text-sm">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-canvas text-muted">
              {a.type === "call" ? <PhoneCall className="size-3.5" aria-hidden /> : <MessageSquare className="size-3.5" aria-hidden />}
            </span>
            <div className="min-w-0">
              <p>
                <span className="font-medium">{LABELS[a.type] ?? a.type}</span>
                {a.callOutcome ? <span> — {CALL_OUTCOME_LABELS[a.callOutcome]}</span> : null}
                {detail(a, timezone) ? <span className="text-muted"> · {detail(a, timezone)}</span> : null}
              </p>
              {a.content ? <p className="whitespace-pre-wrap break-words">{a.content}</p> : null}
              <p className="text-xs text-muted">
                {a.actorName ?? "System"} · <time dateTime={a.occurredAt}>{formatDateTime(a.occurredAt, timezone)}</time>
                {customerId && a.bookingId ? (
                  <>
                    {" · "}
                    <Link href={`/dashboard/bookings/${a.bookingId}`} className="underline">
                      View booking
                    </Link>
                  </>
                ) : null}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {page < totalPages ? (
        <Button variant="secondary" size="sm" loading={loading} onClick={() => void load(page + 1, false)}>
          Load more
        </Button>
      ) : null}
    </div>
  );
}
