"use client";

import { Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { useIdempotencyKey } from "@/lib/client/hooks";

type Kind = "booking_confirmation" | "booking_changed" | "booking_cancelled";
const KIND_LABELS: Record<Kind, string> = { booking_confirmation: "Booking confirmation", booking_changed: "Booking changed", booking_cancelled: "Booking cancelled" };
type Preview = { to: string | null; subject: string | null; text: string | null; blocked: string | null };
type HistoryItem = { id: string; kind: string; to: string; status: string; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null };
const STATUS_TONE: Record<string, "success" | "pending" | "danger" | "slate"> = { sent: "success", pending: "pending", sending: "pending", failed: "danger", cancelled: "slate" };
const STATUS_TEXT: Record<string, string> = { sent: "Sent", pending: "Queued", sending: "Sending", failed: "Failed", cancelled: "Cancelled" };

/** Preview, then explicitly queue a customer email. Nothing is sent without "Send". */
export function EmailCustomerButton({ bookingId, cancelled, timezone }: { bookingId: string; cancelled: boolean; timezone: string }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>(cancelled ? "booking_cancelled" : "booking_confirmation");
  const [data, setData] = useState<{ preview: Preview; history: HistoryItem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const idem = useIdempotencyKey();

  useEffect(() => {
    if (!open) return;
    let cancelledReq = false;
    void apiRequest<{ preview: Preview; history: HistoryItem[] }>(`/api/v1/bookings/${bookingId}/email?kind=${kind}`).then((r) => {
      if (cancelledReq) return;
      if (r.ok) setData(r.data);
      else setMessage({ tone: "danger", text: r.message });
    });
    return () => {
      cancelledReq = true;
    };
  }, [open, kind, bookingId]);

  async function send() {
    setBusy(true);
    setMessage(null);
    const res = await apiRequest(`/api/v1/bookings/${bookingId}/email`, { method: "POST", body: { kind, idempotencyKey: idem.key } });
    setBusy(false);
    if (!res.ok) return setMessage({ tone: "danger", text: res.message });
    idem.renew();
    setMessage({ tone: "success", text: "Queued. It will be delivered by the background worker; check the status below." });
    const r = await apiRequest<{ preview: Preview; history: HistoryItem[] }>(`/api/v1/bookings/${bookingId}/email?kind=${kind}`);
    if (r.ok) setData(r.data);
  }

  const fmt = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  return (
    <>
      <Button variant="secondary" onClick={() => { setOpen(true); setMessage(null); }}>
        <Mail className="size-4" aria-hidden /> Email customer
      </Button>
      <Modal title="Email the customer" open={open} onClose={() => setOpen(false)} wide>
        <div className="space-y-4">
          <Field label="Email">
            {(p) => (
              <Select {...p} data-autofocus value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                {(Object.keys(KIND_LABELS) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </Select>
            )}
          </Field>
          {!data ? (
            <p className="text-sm text-muted">Loading preview…</p>
          ) : (
            <>
              {data.preview.blocked ? <Alert tone="pending" title="Can’t send">{data.preview.blocked}</Alert> : null}
              {data.preview.text ? (
                <div className="rounded-lg border border-line">
                  <p className="border-b border-line px-3 py-2 text-sm"><span className="text-muted">To:</span> {data.preview.to}<br /><span className="text-muted">Subject:</span> {data.preview.subject}</p>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-3 py-2 font-sans text-sm">{data.preview.text}</pre>
                </div>
              ) : null}
              <p className="text-xs text-muted">Includes the date, time, address and services only — never prices, office notes or internal details.</p>
              {data.history.length ? (
                <section aria-labelledby="mail-hist">
                  <h3 id="mail-hist" className="mb-1 text-sm font-semibold">Emails for this booking</h3>
                  <ul className="divide-y divide-line rounded-lg border border-line text-sm">
                    {data.history.map((h) => (
                      <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <span>{KIND_LABELS[h.kind as Kind] ?? h.kind} · {fmt(h.createdAt)}</span>
                        <span className="flex items-center gap-2">
                          <Badge tone={STATUS_TONE[h.status] ?? "slate"}>{STATUS_TEXT[h.status] ?? h.status}</Badge>
                          {h.lastError ? <span className="text-xs text-muted">{h.lastError} · attempt {h.attempts}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
          {message ? <Alert tone={message.tone} title={message.tone === "success" ? "Email queued" : "Not sent"}>{message.text}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
            <Button onClick={() => void send()} loading={busy} disabled={!data || Boolean(data.preview.blocked)}>
              <Mail className="size-4" aria-hidden /> Send
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
