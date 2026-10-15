"use client";

import { Ban, HandCoins, Plus, Undo2, Wallet } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { CustomerPicker, type CustomerPick } from "@/components/ops/booking-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { defaultAllocation } from "@/lib/domain/billing";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/domain/constants";
import { formatCents, parseAmountToCents } from "@/lib/domain/money";
import { formatDate } from "@/lib/domain/time";
import type { OpenCharge } from "@/modules/finance/payments";

/** One key per dialog session: a double-click or retry replays instead of duplicating. */
export function newRequestKey() {
  return crypto.randomUUID().replace(/-/g, "");
}

function nowParts(tz: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

type Allocation = { bookingId: string; lineItemId: string; amountCents: number };

/**
 * Allocation editor over a customer's open charges. Starts from the default
 * (oldest service date first) and lets the user type explicit amounts.
 */
function AllocationEditor({
  open,
  amountCents,
  currency,
  timezone,
  value,
  onChange,
  focusBookingId,
}: {
  open: OpenCharge[];
  amountCents: number | null;
  currency: string;
  timezone: string;
  value: Record<string, string> | null;
  onChange: (v: Record<string, string> | null) => void;
  focusBookingId?: string;
}) {
  const lines = useMemo(
    () => open.flatMap((b) => b.lines.filter((l) => l.balanceCents > 0).map((l) => ({ ...l, bookingId: b.bookingId, reference: b.reference, serviceDate: b.serviceDate }))),
    [open],
  );
  const ordered = useMemo(() => (focusBookingId ? [...lines.filter((l) => l.bookingId === focusBookingId), ...lines.filter((l) => l.bookingId !== focusBookingId)] : lines), [lines, focusBookingId]);
  const preview = useMemo(() => defaultAllocation(amountCents ?? 0, ordered), [amountCents, ordered]);
  if (lines.length === 0) return <p className="text-sm text-muted">Nothing is owed on finalized charges. The full amount will be kept as customer credit.</p>;
  const custom = value !== null;
  const byLine = new Map(preview.allocations.map((a) => [a.lineItemId, a.amountCents]));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Apply to charges</legend>
      <div className="flex flex-wrap gap-2 text-sm">
        <label className="inline-flex items-center gap-2">
          <input type="radio" checked={!custom} onChange={() => onChange(null)} /> Automatic ({focusBookingId ? "this booking first, then " : ""}oldest service date first)
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="radio" checked={custom} onChange={() => onChange(Object.fromEntries(preview.allocations.map((a) => [a.lineItemId, (a.amountCents / 100).toFixed(2)])))} /> Choose amounts
        </label>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-canvas text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Booking · service</th>
              <th className="px-3 py-2 text-right font-medium">Balance</th>
              <th className="px-3 py-2 text-right font-medium">Apply</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ordered.map((l) => (
              <tr key={l.lineItemId}>
                <td className="px-3 py-2">
                  <span className="font-medium">{l.reference}</span> · {formatDate(l.serviceDate, timezone)}
                  <span className="block text-muted">{l.name}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCents(l.balanceCents, currency)}</td>
                <td className="px-3 py-2 text-right">
                  {custom ? (
                    <Input
                      aria-label={`Amount for ${l.reference} ${l.name}`}
                      inputMode="decimal"
                      className="ml-auto h-9 w-28 text-right"
                      value={value?.[l.lineItemId] ?? ""}
                      onChange={(e) => onChange({ ...value, [l.lineItemId]: e.target.value })}
                    />
                  ) : (
                    <span className="tabular-nums">{formatCents(byLine.get(l.lineItemId) ?? 0, currency)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </fieldset>
  );
}

function resolveAllocations(open: OpenCharge[], amountCents: number, custom: Record<string, string> | null, focusBookingId?: string): { allocations: Allocation[]; error?: string } {
  const lines = open.flatMap((b) => b.lines.filter((l) => l.balanceCents > 0).map((l) => ({ ...l, bookingId: b.bookingId })));
  if (!custom) {
    const ordered = focusBookingId ? [...lines.filter((l) => l.bookingId === focusBookingId), ...lines.filter((l) => l.bookingId !== focusBookingId)] : lines;
    return { allocations: defaultAllocation(amountCents, ordered).allocations };
  }
  const allocations: Allocation[] = [];
  for (const l of lines) {
    const raw = custom[l.lineItemId]?.trim();
    if (!raw) continue;
    const c = parseAmountToCents(raw);
    if (c === null || c < 0) return { allocations: [], error: `Enter a valid amount for ${l.name}` };
    if (c > l.balanceCents) return { allocations: [], error: `${l.name}: more than the balance owed` };
    if (c > 0) allocations.push({ bookingId: l.bookingId, lineItemId: l.lineItemId, amountCents: c });
  }
  return { allocations };
}

/** Records money received outside RealtyPacer. No card data is ever collected here. */
export function RecordPaymentButton({
  customer: fixedCustomer,
  bookingId,
  currency,
  timezone,
  label = "Record payment",
  variant = "primary",
}: {
  customer?: { id: string; name: string } | null;
  bookingId?: string;
  currency: string;
  timezone: string;
  label?: string;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState<CustomerPick | null>(null);
  const [charges, setCharges] = useState<OpenCharge[] | null>(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("e_transfer");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [custom, setCustom] = useState<Record<string, string> | null>(null);
  const [requestKey, setRequestKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string } | null>(null);

  const customerId = fixedCustomer?.id ?? customer?.id ?? null;
  useEffect(() => {
    if (!open || !customerId) return;
    let cancelled = false;
    void apiRequest<{ items: OpenCharge[] }>(`/api/v1/customers/${customerId}/open-charges`).then((r) => {
      if (!cancelled) setCharges(r.ok ? r.data.items : []);
    });
    return () => {
      cancelled = true;
    };
  }, [open, customerId]);

  function start() {
    const n = nowParts(timezone);
    setDate(n.date);
    setTime(n.time);
    setAmount("");
    setReference("");
    setNote("");
    setCustom(null);
    setCharges(null);
    setCustomer(null);
    setError(null);
    setDone(null);
    setRequestKey(newRequestKey());
    setOpen(true);
  }

  const amountCents = parseAmountToCents(amount);
  const owed = (charges ?? []).reduce((s, b) => s + b.balanceCents, 0);
  const resolved = charges && amountCents && amountCents > 0 ? resolveAllocations(charges, amountCents, custom, bookingId) : null;
  const applied = resolved?.allocations.reduce((s, a) => s + a.amountCents, 0) ?? 0;
  const leftover = amountCents && amountCents > 0 ? amountCents - applied : 0;

  async function submit() {
    if (!customerId || !amountCents || amountCents <= 0 || !resolved) return setError("Enter the amount received.");
    if (resolved.error) return setError(resolved.error);
    if (leftover < 0) return setError("The amounts applied add up to more than the payment.");
    setBusy(true);
    setError(null);
    const res = await apiRequest<{ id: string }>("/api/v1/payments", {
      method: "POST",
      body: { idempotencyKey: requestKey, customerId, amountCents, currency, receivedDate: date, receivedTime: time, method, reference, note, allocations: resolved.allocations },
    });
    setBusy(false);
    if (!res.ok) {
      const fe = res.fieldErrors ? Object.values(res.fieldErrors)[0]?.[0] : undefined;
      // Allocation conflicts (someone else paid the same line) need fresh balances.
      if (res.status === 409) void apiRequest<{ items: OpenCharge[] }>(`/api/v1/customers/${customerId}/open-charges`).then((r) => r.ok && setCharges(r.data.items));
      return setError(fe ?? res.message);
    }
    setDone({ id: res.data.id });
    router.refresh();
  }

  return (
    <>
      <Button variant={variant} onClick={start}>
        <Plus className="size-4" aria-hidden /> {label}
      </Button>
      <Modal title="Record payment received" open={open} onClose={() => setOpen(false)} wide>
        {done ? (
          <div className="space-y-4">
            <Alert tone="success" title="Payment recorded">
              The receipt is saved. Any amount not applied to a charge stays on the customer as credit.
            </Alert>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
              <Link href={`/dashboard/payments/${done.id}`} className="inline-flex h-11 items-center rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover">
                View receipt
              </Link>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <p className="text-sm text-muted">
              Record money already received (cash, e-Transfer, cheque, or a card processed on another terminal). RealtyPacer does not charge cards or move money.
            </p>
            {fixedCustomer ? (
              <p className="text-sm">
                Customer: <span className="font-semibold">{fixedCustomer.name}</span>
              </p>
            ) : (
              <CustomerPicker value={customer} onChange={(c) => { setCustomer(c); setCharges(null); setCustom(null); }} canCreate={false} />
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={`Amount received (${currency})`} required hint={charges ? `Currently owed on finalized charges: ${formatCents(owed, currency)}` : undefined}>
                {(p) => <Input {...p} data-autofocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" required />}
              </Field>
              <Field label="Method" required>
                {(p) => (
                  <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Date received" required hint={`Organization time (${timezone})`}>
                {(p) => <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}
              </Field>
              <Field label="Time received" required>
                {(p) => <Input {...p} type="time" value={time} onChange={(e) => setTime(e.target.value)} required />}
              </Field>
              <Field label="Reference" hint="e.g. e-Transfer confirmation or cheque number. Never a card number.">
                {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} autoComplete="off" />}
              </Field>
              <Field label="Note">
                {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />}
              </Field>
            </div>
            {customerId ? (
              charges === null ? (
                <p className="text-sm text-muted">Loading open charges…</p>
              ) : (
                <AllocationEditor open={charges} amountCents={amountCents} currency={currency} timezone={timezone} value={custom} onChange={setCustom} focusBookingId={bookingId} />
              )
            ) : null}
            {amountCents && amountCents > 0 && resolved && !resolved.error ? (
              <dl className="grid grid-cols-2 gap-1 rounded-lg bg-canvas p-3 text-sm sm:grid-cols-3">
                <dt className="text-muted">Received</dt>
                <dd className="text-right tabular-nums sm:col-span-2">{formatCents(amountCents, currency)}</dd>
                <dt className="text-muted">Applied to charges</dt>
                <dd className="text-right tabular-nums sm:col-span-2">{formatCents(applied, currency)}</dd>
                <dt className="text-muted">Kept as credit</dt>
                <dd className={`text-right tabular-nums sm:col-span-2 ${leftover < 0 ? "text-danger" : ""}`}>{formatCents(leftover, currency)}</dd>
              </dl>
            ) : null}
            {error ? <Alert tone="danger" title="Not recorded">{error}</Alert> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={!customerId}>
                <Wallet className="size-4" aria-hidden /> Record payment
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}

/** Applies unallocated credit from one receipt to open charges. */
export function ApplyCreditButton({ paymentId, customerId, revision, availableCents, currency, timezone }: { paymentId: string; customerId: string; revision: number; availableCents: number; currency: string; timezone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [charges, setCharges] = useState<OpenCharge[] | null>(null);
  const [custom, setCustom] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setOpen(true);
    setError(null);
    setCustom(null);
    const r = await apiRequest<{ items: OpenCharge[] }>(`/api/v1/customers/${customerId}/open-charges`);
    setCharges(r.ok ? r.data.items : []);
  }
  async function submit() {
    if (!charges) return;
    const resolved = resolveAllocations(charges, availableCents, custom);
    if (resolved.error) return setError(resolved.error);
    const total = resolved.allocations.reduce((s, a) => s + a.amountCents, 0);
    if (total === 0) return setError("Nothing to apply.");
    if (total > availableCents) return setError(`Only ${formatCents(availableCents, currency)} of credit is available.`);
    setBusy(true);
    const res = await apiRequest(`/api/v1/payments/${paymentId}/allocate`, { method: "POST", body: { expectedRevision: revision, allocations: resolved.allocations } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <Button variant="secondary" onClick={() => void start()}>
        <HandCoins className="size-4" aria-hidden /> Apply credit
      </Button>
      <Modal title="Apply credit to charges" open={open} onClose={() => setOpen(false)} wide>
        <div className="space-y-4">
          <p className="text-sm">Available credit on this receipt: <span className="font-semibold tabular-nums">{formatCents(availableCents, currency)}</span></p>
          {charges === null ? <p className="text-sm text-muted">Loading open charges…</p> : <AllocationEditor open={charges} amountCents={availableCents} currency={currency} timezone={timezone} value={custom} onChange={setCustom} />}
          {error ? <Alert tone="danger" title="Not applied">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={busy} onClick={() => void submit()} disabled={!charges || charges.length === 0}>Apply credit</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

type RefundablePart = { allocationId: string | null; label: string; availableCents: number };

/** Records a refund already made outside RealtyPacer. Nothing is sent to the customer or a bank. */
export function RefundButton({ paymentId, parts, currency, timezone }: { paymentId: string; parts: RefundablePart[]; currency: string; timezone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [requestKey, setRequestKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyOf = (p: RefundablePart) => p.allocationId ?? "credit";

  function start() {
    const n = nowParts(timezone);
    setDate(n.date);
    setTime(n.time);
    setAmounts({});
    setReason("");
    setReference("");
    setError(null);
    setRequestKey(newRequestKey());
    setOpen(true);
  }
  async function submit() {
    const portions: { allocationId: string | null; amountCents: number }[] = [];
    for (const p of parts) {
      const raw = amounts[keyOf(p)]?.trim();
      if (!raw) continue;
      const c = parseAmountToCents(raw);
      if (c === null || c < 0) return setError(`Enter a valid amount for ${p.label}`);
      if (c > p.availableCents) return setError(`${p.label}: at most ${formatCents(p.availableCents, currency)}`);
      if (c > 0) portions.push({ allocationId: p.allocationId, amountCents: c });
    }
    const total = portions.reduce((s, p) => s + p.amountCents, 0);
    if (total === 0) return setError("Enter the amount refunded.");
    setBusy(true);
    setError(null);
    const res = await apiRequest(`/api/v1/payments/${paymentId}/refunds`, { method: "POST", body: { idempotencyKey: requestKey, amountCents: total, refundedDate: date, refundedTime: time, reason, reference, portions } });
    setBusy(false);
    if (!res.ok) return setError(res.fieldErrors ? (Object.values(res.fieldErrors)[0]?.[0] ?? res.message) : res.message);
    setOpen(false);
    router.refresh();
  }
  const total = parts.reduce((s, p) => s + (parseAmountToCents(amounts[keyOf(p)] ?? "") ?? 0), 0);
  return (
    <>
      <Button variant="secondary" onClick={start}>
        <Undo2 className="size-4" aria-hidden /> Record refund
      </Button>
      <Modal title="Record a refund" open={open} onClose={() => setOpen(false)} wide>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Alert tone="info" title="Refunds are recorded, not sent">
            Return the money first (cash, e-Transfer, or the card terminal you used), then record it here. Refunded charges become owed again unless you also add a credit adjustment.
          </Alert>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Refund from</th>
                  <th className="px-3 py-2 text-right font-medium">Refundable</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {parts.map((p, i) => (
                  <tr key={keyOf(p)}>
                    <td className="px-3 py-2">{p.label}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCents(p.availableCents, currency)}</td>
                    <td className="px-3 py-2 text-right">
                      <Input data-autofocus={i === 0 ? true : undefined} aria-label={`Refund amount for ${p.label}`} inputMode="decimal" className="ml-auto h-9 w-28 text-right" value={amounts[keyOf(p)] ?? ""} onChange={(e) => setAmounts({ ...amounts, [keyOf(p)]: e.target.value })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm">Total refund: <span className="font-semibold tabular-nums">{formatCents(total, currency)}</span></p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date refunded" required>
              {(p) => <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}
            </Field>
            <Field label="Time refunded" required>
              {(p) => <Input {...p} type="time" value={time} onChange={(e) => setTime(e.target.value)} required />}
            </Field>
            <Field label="Reason" required>
              {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={1000} required />}
            </Field>
            <Field label="Reference">
              {(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />}
            </Field>
          </div>
          {error ? <Alert tone="danger" title="Not recorded">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={reason.trim().length < 3}>Record refund</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

/** Marks a receipt entered by mistake as reversed. History is kept. */
export function ReversePaymentButton({ paymentId, revision }: { paymentId: string; revision: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    setBusy(true);
    setError(null);
    const res = await apiRequest(`/api/v1/payments/${paymentId}/reverse`, { method: "POST", body: { expectedRevision: revision, reason } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <Button variant="danger" onClick={() => { setOpen(true); setReason(""); setError(null); }}>
        <Ban className="size-4" aria-hidden /> Reverse receipt
      </Button>
      <Modal title="Reverse this receipt?" open={open} onClose={() => setOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm">Use this only for a receipt recorded by mistake (wrong customer, duplicate, payment that never arrived). Its allocations are removed and the charges become owed again. The receipt stays in history as reversed. To return money that was received, record a refund instead.</p>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Reason (required)</span>
            <textarea data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} required minLength={3} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm" />
          </label>
          {error ? <Alert tone="danger" title="Not reversed">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Back</Button>
            <Button type="submit" variant="danger" loading={busy} disabled={reason.trim().length < 3}>Reverse receipt</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
