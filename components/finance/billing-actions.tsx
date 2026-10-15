"use client";

import { FileLock2, MinusCircle, Percent, SlidersHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { percentToBasisPoints } from "@/lib/domain/billing";
import { formatCents, parseAmountToCents } from "@/lib/domain/money";
import { newRequestKey } from "./payment-dialogs";

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(path: string, body: unknown, after: () => void) {
    setBusy(true);
    setError(null);
    const res = await apiRequest(path, { method: "POST", body });
    setBusy(false);
    if (!res.ok) {
      setError(res.fieldErrors ? (Object.values(res.fieldErrors)[0]?.[0] ?? res.message) : res.message);
      return;
    }
    after();
    router.refresh();
  }
  return { busy, error, setError, run };
}

/** Draft only: a booking-level discount spread over the lines. */
export function DiscountButton({ bookingId, version, current, currency }: { bookingId: string; version: number; current: { type: "none" | "fixed" | "percent"; amountCents: number; basisPoints: number }; currency: string }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState(current.type);
  const [value, setValue] = useState(current.type === "fixed" ? (current.amountCents / 100).toFixed(2) : current.type === "percent" ? String(current.basisPoints / 100) : "");
  const a = useAction();
  function submit() {
    if (type === "none") return void a.run(`/api/v1/bookings/${bookingId}/discount`, { expectedVersion: version, type }, () => setOpen(false));
    if (type === "fixed") {
      const c = parseAmountToCents(value);
      if (c === null || c < 0) return a.setError("Enter a valid amount.");
      return void a.run(`/api/v1/bookings/${bookingId}/discount`, { expectedVersion: version, type, amountCents: c }, () => setOpen(false));
    }
    const bp = percentToBasisPoints(value);
    if (bp === null) return a.setError("Enter a percentage between 0 and 100 (up to 2 decimals).");
    void a.run(`/api/v1/bookings/${bookingId}/discount`, { expectedVersion: version, type, basisPoints: bp }, () => setOpen(false));
  }
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => { setOpen(true); a.setError(null); }}>
        <Percent className="size-4" aria-hidden /> Discount
      </Button>
      <Modal title="Booking discount" open={open} onClose={() => setOpen(false)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <p className="text-sm text-muted">Applied before tax and spread across the services in proportion to their price. Can be changed until charges are finalized.</p>
          <Field label="Discount">
            {(p) => (
              <Select {...p} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                <option value="none">No discount</option>
                <option value="fixed">Fixed amount ({currency})</option>
                <option value="percent">Percentage</option>
              </Select>
            )}
          </Field>
          {type !== "none" ? (
            <Field label={type === "fixed" ? `Amount (${currency})` : "Percent"} required>
              {(p) => <Input {...p} data-autofocus inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}
            </Field>
          ) : null}
          {a.error ? <Alert tone="danger" title="Not saved">{a.error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={a.busy}>Save discount</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export function FinalizeButton({ bookingId, version, chargedCents, taxNote, currency }: { bookingId: string; version: number; chargedCents: number; taxNote: string; currency: string }) {
  const [open, setOpen] = useState(false);
  const a = useAction();
  return (
    <>
      <Button size="sm" onClick={() => { setOpen(true); a.setError(null); }}>
        <FileLock2 className="size-4" aria-hidden /> Finalize charges
      </Button>
      <Modal title="Finalize charges?" open={open} onClose={() => setOpen(false)}>
        <div className="space-y-4">
          <p className="text-sm">
            The customer will owe <span className="font-semibold tabular-nums">{formatCents(chargedCents, currency)}</span>. {taxNote} After this, service prices, quantities and the discount are locked; corrections are made with adjustments that keep history.
          </p>
          {a.error ? <Alert tone="danger" title="Not finalized">{a.error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Back</Button>
            <Button data-autofocus loading={a.busy} onClick={() => void a.run(`/api/v1/bookings/${bookingId}/finalize`, { expectedVersion: version }, () => setOpen(false))}>Finalize</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

/** Finalized only: an append-only credit or extra charge on one line. */
export function AdjustLineButton({ bookingId, lines, currency }: { bookingId: string; lines: { lineItemId: string; name: string; effectiveCents: number; paidCents: number }[]; currency: string }) {
  const [open, setOpen] = useState(false);
  const [lineId, setLineId] = useState(lines[0]?.lineItemId ?? "");
  const [direction, setDirection] = useState<"credit" | "charge">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState("");
  const a = useAction();
  const line = lines.find((l) => l.lineItemId === lineId);
  function submit() {
    const c = parseAmountToCents(amount);
    if (c === null || c <= 0) return a.setError("Enter a positive amount.");
    void a.run(`/api/v1/bookings/${bookingId}/adjustments`, { idempotencyKey: key, lineItemId: lineId, amountCents: direction === "credit" ? -c : c, reason }, () => setOpen(false));
  }
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => { setOpen(true); setAmount(""); setReason(""); a.setError(null); setKey(newRequestKey()); }}>
        <SlidersHorizontal className="size-4" aria-hidden /> Adjust charge
      </Button>
      <Modal title="Adjust a finalized charge" open={open} onClose={() => setOpen(false)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <p className="text-sm text-muted">A credit lowers what is owed (goodwill, a mistake). It is not a refund — no money is returned. A charge adds to what is owed.</p>
          <Field label="Service" required>
            {(p) => (
              <Select {...p} value={lineId} onChange={(e) => setLineId(e.target.value)}>
                {lines.map((l) => <option key={l.lineItemId} value={l.lineItemId}>{l.name} — {formatCents(l.effectiveCents, currency)} charged, {formatCents(l.paidCents, currency)} paid</option>)}
              </Select>
            )}
          </Field>
          <Field label="Type" required>
            {(p) => (
              <Select {...p} value={direction} onChange={(e) => setDirection(e.target.value as "credit" | "charge")}>
                <option value="credit">Credit (lower the charge)</option>
                <option value="charge">Extra charge</option>
              </Select>
            )}
          </Field>
          <Field label={`Amount (${currency})`} required hint={direction === "credit" && line ? `At most ${formatCents(Math.max(0, line.effectiveCents - line.paidCents), currency)} without refunding first` : undefined}>
            {(p) => <Input {...p} data-autofocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Reason" required>
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={1000} />}
          </Field>
          {a.error ? <Alert tone="danger" title="Not saved">{a.error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={a.busy} disabled={reason.trim().length < 3}>Save adjustment</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** Cancelled + finalized: credit whatever is still unpaid so nothing is owed. */
export function CancellationCreditButton({ bookingId, unpaidCents, currency }: { bookingId: string; unpaidCents: number; currency: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [key, setKey] = useState("");
  const a = useAction();
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => { setOpen(true); setReason(""); a.setError(null); setKey(newRequestKey()); }}>
        <MinusCircle className="size-4" aria-hidden /> Credit unpaid balance
      </Button>
      <Modal title="Credit the unpaid balance?" open={open} onClose={() => setOpen(false)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void a.run(`/api/v1/bookings/${bookingId}/cancellation-credit`, { idempotencyKey: key, reason }, () => setOpen(false)); }}>
          <p className="text-sm">
            Credits <span className="font-semibold tabular-nums">{formatCents(unpaidCents, currency)}</span> so this cancelled booking no longer shows as owed. Money already paid stays applied; record a refund separately if you return it.
          </p>
          <Field label="Reason" required>
            {(p) => <Input {...p} data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={1000} />}
          </Field>
          {a.error ? <Alert tone="danger" title="Not saved">{a.error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Back</Button>
            <Button type="submit" loading={a.busy} disabled={reason.trim().length < 3}>Credit balance</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
