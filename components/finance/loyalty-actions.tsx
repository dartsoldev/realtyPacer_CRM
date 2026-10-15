"use client";

import { Gift, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { newRequestKey } from "./payment-dialogs";

type Kind = "grant" | "redeem" | "correction";
const KIND_LABELS: Record<Kind, string> = { grant: "Grant points", redeem: "Redeem points", correction: "Correction (+ or −)" };

/** Points change only through ledger entries; the balance is never edited directly. */
export function LoyaltyEntryButton({ customerId, balance, compact }: { customerId: string; balance: number; compact?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("grant");
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [requestKey, setRequestKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const n = Number(points);
    if (!Number.isInteger(n) || n === 0 || (kind !== "correction" && n < 0)) return setError("Enter a whole number of points.");
    setBusy(true);
    setError(null);
    const body = kind === "correction" ? { type: kind, idempotencyKey: requestKey, pointsChange: n, reason } : { type: kind, idempotencyKey: requestKey, points: n, reason };
    const res = await apiRequest(`/api/v1/customers/${customerId}/loyalty`, { method: "POST", body });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <Button variant="secondary" size={compact ? "sm" : "md"} className="whitespace-nowrap" onClick={() => { setOpen(true); setPoints(""); setReason(""); setError(null); setRequestKey(newRequestKey()); }}>
        <Gift className="size-4" aria-hidden /> Adjust points
      </Button>
      <Modal title="Loyalty points entry" open={open} onClose={() => setOpen(false)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <p className="text-sm">Current balance: <span className="font-semibold tabular-nums">{balance}</span> points. Redemptions can’t take the balance below zero.</p>
          <Field label="Entry type" required>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                {(Object.keys(KIND_LABELS) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
              </Select>
            )}
          </Field>
          <Field label={kind === "correction" ? "Points change (use − to remove)" : "Points"} required>
            {(p) => <Input {...p} data-autofocus inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value)} required />}
          </Field>
          <Field label="Reason" required>
            {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required />}
          </Field>
          {error ? <Alert tone="danger" title="Not saved">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={reason.trim().length < 3}>Save entry</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export function ReverseLoyaltyButton({ customerId, entryId }: { customerId: string; entryId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [requestKey, setRequestKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    const res = await apiRequest(`/api/v1/customers/${customerId}/loyalty`, { method: "POST", body: { type: "reversal", idempotencyKey: requestKey, entryId, reason } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => { setOpen(true); setReason(""); setError(null); setRequestKey(newRequestKey()); }}>
        <RotateCcw className="size-4" aria-hidden /> Reverse
      </Button>
      <Modal title="Reverse this points entry?" open={open} onClose={() => setOpen(false)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <p className="text-sm">A new entry with the opposite change is added. The original stays in history.</p>
          <Field label="Reason" required>
            {(p) => <Input {...p} data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required />}
          </Field>
          {error ? <Alert tone="danger" title="Not reversed">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Back</Button>
            <Button type="submit" variant="danger" loading={busy} disabled={reason.trim().length < 3}>Reverse entry</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
