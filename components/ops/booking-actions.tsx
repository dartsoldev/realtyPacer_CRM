"use client";

import { CheckCircle2, MapPinned, PlayCircle, RotateCcw, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/client/api";
import { formatAddress } from "@/lib/domain/links";
import type { BookingAction } from "@/modules/bookings/schemas";
import type { AddressDTO } from "@/modules/customers/addresses";

const META: Record<BookingAction, { label: string; icon: typeof PlayCircle; variant: "primary" | "secondary" | "danger"; needsReason: boolean; confirm: string }> = {
  start: { label: "Start job", icon: PlayCircle, variant: "primary", needsReason: false, confirm: "Mark this job as started now?" },
  complete: { label: "Complete job", icon: CheckCircle2, variant: "primary", needsReason: false, confirm: "Mark this job as completed now?" },
  cancel: { label: "Cancel booking", icon: XCircle, variant: "danger", needsReason: true, confirm: "Cancelling keeps the booking and its history. Payments are never deleted or refunded automatically." },
  reopen: { label: "Reopen job", icon: RotateCcw, variant: "secondary", needsReason: true, confirm: "Reopening a completed job is recorded in the audit history." },
};

/** Lifecycle buttons for the actions the server says this viewer may perform. */
export function BookingActions({ bookingId, version, actions }: { bookingId: string; version: number; actions: BookingAction[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<BookingAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: BookingAction) {
    setBusy(true);
    setError(null);
    const res = await apiRequest(`/api/v1/bookings/${bookingId}/transition`, { method: "POST", body: { action, expectedVersion: version, reason } });
    setBusy(false);
    if (!res.ok) {
      setError(res.code === "STALE_VERSION" ? `${res.message}` : res.fieldErrors?.reason?.[0] ?? res.message);
      return;
    }
    setPending(null);
    setReason("");
    router.refresh();
  }

  if (actions.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => {
          const m = META[a];
          return (
            <Button key={a} variant={m.variant} onClick={() => { setPending(a); setError(null); }}>
              <m.icon className="size-4" aria-hidden /> {m.label}
            </Button>
          );
        })}
      </div>
      {error && !pending ? <Alert tone="danger" title="Not changed">{error}</Alert> : null}
      <Modal title={pending ? META[pending].label : ""} open={Boolean(pending)} onClose={() => setPending(null)}>
        {pending ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(pending);
            }}
          >
            <p className="text-sm">{META[pending].confirm}</p>
            {META[pending].needsReason ? (
              <label className="block text-sm">
                <span className="mb-1 block font-medium">Reason (required)</span>
                <textarea data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} required minLength={3} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm" />
              </label>
            ) : null}
            {error ? <Alert tone="danger" title="Not changed">{error}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setPending(null)}>
                Back
              </Button>
              <Button
                type="submit"
                data-autofocus={META[pending].needsReason ? undefined : true}
                variant={META[pending].variant === "danger" ? "danger" : "primary"}
                loading={busy}
                disabled={META[pending].needsReason && reason.trim().length < 3}
              >
                Confirm
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

/** Explicitly move a future booking to another (or updated) address of the same customer. */
export function ChangeAddressButton({ bookingId, customerId, version, currentAddressId }: { bookingId: string; customerId: string; version: number; currentAddressId: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [addresses, setAddresses] = useState<AddressDTO[] | null>(null);
  const [selected, setSelected] = useState(currentAddressId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openDialog() {
    setOpen(true);
    const r = await apiRequest<{ items: AddressDTO[] }>(`/api/v1/customers/${customerId}/addresses`);
    setAddresses(r.ok ? r.data.items : []);
  }
  async function save() {
    setBusy(true);
    setError(null);
    const res = await apiRequest(`/api/v1/bookings/${bookingId}/address`, { method: "POST", body: { addressId: selected, expectedVersion: version } });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => void openDialog()}>
        <MapPinned className="size-4" aria-hidden /> Change address
      </Button>
      <Modal title="Change service address" open={open} onClose={() => setOpen(false)}>
        <div className="space-y-3 text-sm">
          <p className="text-muted">Choosing an address (even the same one) copies its current details onto this booking. The change is recorded in the booking history.</p>
          {addresses === null ? <p className="text-muted">Loading…</p> : null}
          {addresses?.map((a) => (
            <label key={a.id} className="flex items-start gap-2 rounded-lg border border-line p-3 has-[:checked]:border-brand">
              <input type="radio" name="addr" className="mt-0.5 accent-brand" checked={selected === a.id} onChange={() => setSelected(a.id)} />
              <span>
                <span className="font-medium">{a.label || "Address"}</span>
                <span className="block text-muted">{formatAddress(a)}</span>
              </span>
            </label>
          ))}
          {error ? <Alert tone="danger" title="Not changed">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!selected} onClick={() => void save()}>
              Use this address
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
