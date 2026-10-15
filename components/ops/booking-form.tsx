"use client";

import Link from "next/link";
import { Plus, Trash2, UserPlus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { CustomFieldInputs, changedCustomFields, useCustomFieldDefs, type CustomFieldDraft } from "@/components/custom-fields/inputs";
import { useDebounced, useIdempotencyKey, useUnsavedChangesWarning } from "@/lib/client/hooks";
import { formatMinutes } from "@/lib/domain/duration";
import { formatAddress } from "@/lib/domain/links";
import { formatCents, parseAmountToCents } from "@/lib/domain/money";
import { formatDateTime } from "@/lib/domain/time";
import type { BookingDTO, ScheduleConflict } from "@/modules/bookings/service";
import type { ServiceDTO } from "@/modules/catalog/service";
import type { AddressDTO } from "@/modules/customers/addresses";
import { AddressDialog } from "./address-manager";
import { CustomerForm, type CreatedCustomer } from "./customer-form";

export type BookingFormOptions = {
  services: ServiceDTO[];
  cleaners: { id: string; name: string; phoneDisplay: string | null }[];
  timezone: string;
  currency: string;
  canPrice: boolean;
  canOverride: boolean;
  canCreateCustomer: boolean;
};

type Line = { key: string; lineItemId?: string; serviceId: string; name?: string; unitLabel?: string; quantity: string; price: string; catalogPrice: number | null; durationMinutes: number };
export type CustomerPick = { id: string; name: string; phoneDisplay: string | null; email: string | null; primaryCity: string | null };

let lineCounter = 0;
const newLineKey = () => `l${++lineCounter}`;

export function CustomerPicker({ value, onChange, canCreate }: { value: CustomerPick | null; onChange: (c: CustomerPick | null) => void; canCreate: boolean }) {
  const [q, setQ] = useState("");
  const debounced = useDebounced(q, 300);
  const [results, setResults] = useState<CustomerPick[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const listId = useId();

  useEffect(() => {
    if (debounced.trim().length < 2) return;
    // Abort the previous lookup when the user keeps typing (no stale responses, no wasted queries).
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag for a server lookup
    setLoading(true);
    void apiRequest<{ items: CustomerPick[] }>(`/api/v1/customers/lookup?q=${encodeURIComponent(debounced.trim())}`, { signal: controller.signal }).then((r) => {
      if (controller.signal.aborted) return;
      setLoading(false);
      setResults(r.ok ? r.data.items : []);
    });
    return () => controller.abort();
  }, [debounced]);

  if (value) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-canvas p-3 text-sm">
        <div>
          <p className="font-semibold">{value.name}</p>
          <p className="text-muted">{[value.phoneDisplay, value.email, value.primaryCity].filter(Boolean).join(" · ") || "No contact details"}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          <X className="size-4" aria-hidden /> Change customer
        </Button>
      </div>
    );
  }
  const showResults = q.trim().length >= 2;
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium" htmlFor={`${listId}-input`}>
        Find customer <span className="text-muted">(required)</span>
      </label>
      <Input id={`${listId}-input`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or email" autoComplete="off" aria-controls={listId} aria-describedby={`${listId}-hint`} />
      <p id={`${listId}-hint`} className="text-xs text-muted">Type at least 2 characters. Check the phone or email to tell people with the same name apart.</p>
      {showResults ? (
        <ul id={listId} aria-label="Matching customers" aria-busy={loading} className="divide-y divide-line rounded-lg border border-line">
          {loading && results.length === 0 ? <li className="px-3 py-2 text-sm text-muted">Searching…</li> : null}
          {!loading && results.length === 0 ? <li className="px-3 py-2 text-sm text-muted">No matching customers.</li> : null}
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => onChange(r)} className="w-full px-3 py-2 text-left text-sm hover:bg-canvas focus-visible:bg-canvas">
                <span className="font-medium">{r.name}</span>
                <span className="block text-muted">{[r.phoneDisplay, r.email, r.primaryCity].filter(Boolean).join(" · ") || "No contact details"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {canCreate ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => setCreating(true)}>
          <UserPlus className="size-4" aria-hidden /> New customer
        </Button>
      ) : null}
      <Modal title="New customer" open={creating} onClose={() => setCreating(false)} wide>
        <CustomerForm
          mode="create"
          onCancel={() => setCreating(false)}
          onCreated={(c: CreatedCustomer) => {
            setCreating(false);
            onChange({ id: c.id, name: c.name, phoneDisplay: c.phoneDisplay, email: c.email, primaryCity: c.primaryCity });
          }}
        />
      </Modal>
    </div>
  );
}

export function BookingForm({
  mode,
  options,
  initial,
  prefill,
}: {
  mode: "create" | "edit";
  options: BookingFormOptions;
  initial?: BookingDTO;
  prefill?: { customer?: CustomerPick | null; date?: string; time?: string };
}) {
  const router = useRouter();
  const idem = useIdempotencyKey();
  const serviceById = useMemo(() => new Map(options.services.map((s) => [s.id, s])), [options.services]);
  const editable = new Set(initial?.editable ?? ["schedule", "lineItems", "cleaners", "instructions", "officeNotes", "address"]);

  const [customer, setCustomer] = useState<CustomerPick | null>(
    initial ? { id: initial.customer.id, name: initial.customer.name, phoneDisplay: initial.customer.phoneDisplay, email: initial.customer.email, primaryCity: initial.address.city } : (prefill?.customer ?? null),
  );
  const [addresses, setAddresses] = useState<AddressDTO[] | null>(null);
  const [addressId, setAddressId] = useState<string>(initial?.address.addressId ?? "");
  const [addingAddress, setAddingAddress] = useState(false);
  const [date, setDate] = useState(initial?.local.date ?? prefill?.date ?? "");
  const [startTime, setStartTime] = useState(initial?.local.startTime ?? prefill?.time ?? "09:00");
  const [duration, setDuration] = useState(String(initial?.durationMinutes ?? 120));
  const [durationTouched, setDurationTouched] = useState(Boolean(initial));
  const [lines, setLines] = useState<Line[]>(() =>
    initial
      ? initial.lineItems.map((l) => ({
          key: newLineKey(),
          lineItemId: l.id,
          serviceId: l.serviceId,
          name: l.name,
          unitLabel: l.unitLabel,
          quantity: String(l.quantity),
          price: l.unitPriceCents !== null ? (l.unitPriceCents / 100).toFixed(2) : "",
          catalogPrice: l.unitPriceCents,
          durationMinutes: l.durationMinutes,
        }))
      : [{ key: newLineKey(), serviceId: "", quantity: "1", price: "", catalogPrice: null, durationMinutes: 0 }],
  );
  const [cleanerIds, setCleanerIds] = useState<string[]>(initial?.cleaners.map((c) => c.id) ?? []);
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [officeNotes, setOfficeNotes] = useState(initial?.officeNotes ?? "");
  const cfDefs = useCustomFieldDefs("booking");
  const [cf, setCf] = useState<CustomFieldDraft>(initial?.customFields ?? {});
  const [status, setStatus] = useState<"SCHEDULED" | "COMPLETED">("SCHEDULED");
  const [disambiguation, setDisambiguation] = useState<"earlier" | "later" | null>(null);
  const [ambiguous, setAmbiguous] = useState<{ earlier: string; later: string } | null>(null);
  const [conflicts, setConflicts] = useState<ScheduleConflict[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesWarning(dirty && !saving);
  const touch = () => setDirty(true);

  // Load the selected customer's current addresses (create mode, or to show options in edit mode).
  useEffect(() => {
    if (!customer || mode === "edit") return;
    let cancelled = false;
    void apiRequest<{ items: AddressDTO[] }>(`/api/v1/customers/${customer.id}/addresses`).then((r) => {
      if (cancelled) return;
      const items = r.ok ? r.data.items : [];
      setAddresses(items);
      setAddressId((prev) => (items.some((a) => a.id === prev) ? prev : (items.find((a) => a.isPrimary)?.id ?? items[0]?.id ?? "")));
    });
    return () => {
      cancelled = true;
    };
  }, [customer, mode]);

  const computed = lines.map((l) => {
    const svc = serviceById.get(l.serviceId);
    const qty = Number(l.quantity);
    const unit = options.canOverride && l.price !== "" ? parseAmountToCents(l.price) : l.lineItemId ? l.catalogPrice : (svc?.defaultPriceCents ?? null);
    const minutes = l.lineItemId ? l.durationMinutes : (svc?.durationMinutes ?? 0);
    return { ...l, qty, unit, minutes, total: Number.isInteger(qty) && unit !== null ? qty * unit : null, unitLabel: l.unitLabel ?? svc?.unitLabel ?? "item" };
  });
  const estimatedMinutes = computed.reduce((s, l) => s + (Number.isInteger(l.qty) ? l.qty * l.minutes : 0), 0);
  const subtotal = computed.every((l) => l.total !== null) ? computed.reduce((s, l) => s + (l.total ?? 0), 0) : null;

  useEffect(() => {
    // Suggest a duration from the selected services until the user sets one.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived default the user may override
    if (!durationTouched && estimatedMinutes > 0) setDuration(String(Math.min(1440, Math.max(15, estimatedMinutes))));
  }, [estimatedMinutes, durationTouched]);

  const updateLine = (key: string, patch: Partial<Line>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    touch();
  };

  async function submit() {
    setFailure(null);
    setConflicts(null);
    const errs: Record<string, string> = {};
    if (mode === "create" && !customer) errs.customer = "Choose a customer";
    if (mode === "create" && !addressId) errs.addressId = "Choose or add a service address";
    if (!date) errs.date = "Choose a date";
    if (!/^\d{2}:\d{2}$/.test(startTime)) errs.startTime = "Choose a start time";
    const minutes = Number(duration);
    if (!Number.isInteger(minutes) || minutes < 15 || minutes > 1440) errs.duration = "Between 15 minutes and 24 hours";
    computed.forEach((l, i) => {
      if (!l.serviceId) errs[`line${i}`] = "Choose a service";
      else if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 1000) errs[`line${i}`] = "Quantity must be a whole number from 1 to 1000";
      else if (options.canOverride && l.price !== "" && parseAmountToCents(l.price) === null) errs[`line${i}`] = "Enter a valid price";
    });
    if (lines.length === 0) errs.lines = "Add at least one service";
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;

    const lineItems = computed.map((l) => {
      const item: Record<string, unknown> = { serviceId: l.serviceId, quantity: l.qty };
      if (l.lineItemId) item.lineItemId = l.lineItemId;
      if (options.canOverride && l.price !== "") item.unitPriceCents = parseAmountToCents(l.price);
      return item;
    });
    setSaving(true);
    let res;
    if (mode === "create") {
      res = await apiRequest<BookingDTO>("/api/v1/bookings", {
        method: "POST",
        body: {
          idempotencyKey: idem.key,
          customerId: customer!.id,
          addressId,
          date,
          startTime,
          durationMinutes: minutes,
          ...(disambiguation ? { disambiguation } : {}),
          lineItems,
          cleanerIds,
          instructions,
          officeNotes,
          status,
          customFields: changedCustomFields(cfDefs, {}, cf),
        },
      });
    } else {
      const body: Record<string, unknown> = { expectedVersion: initial!.version };
      if (editable.has("schedule")) Object.assign(body, { date, startTime, durationMinutes: minutes, ...(disambiguation ? { disambiguation } : {}) });
      if (editable.has("lineItems")) body.lineItems = lineItems;
      if (editable.has("cleaners")) body.cleanerIds = cleanerIds;
      if (editable.has("instructions")) body.instructions = instructions;
      if (editable.has("officeNotes")) body.officeNotes = officeNotes;
      const cfChanges = changedCustomFields(cfDefs, initial!.customFields ?? {}, cf);
      if (cfChanges && editable.has("officeNotes")) body.customFields = cfChanges;
      res = await apiRequest<BookingDTO>(`/api/v1/bookings/${initial!.id}`, { method: "PATCH", body });
    }
    setSaving(false);
    if (res.ok) {
      setDirty(false);
      router.push(`/dashboard/bookings/${res.data.id}`);
      router.refresh();
      return;
    }
    if (res.code === "AMBIGUOUS_LOCAL_TIME") {
      setAmbiguous(res.details?.options as { earlier: string; later: string });
      setFailure(res.message);
      return;
    }
    if (res.code === "SCHEDULE_CONFLICT") {
      setConflicts((res.details?.conflicts as ScheduleConflict[]) ?? []);
      setFailure(res.message);
      return;
    }
    if (res.code === "NETWORK_ERROR") {
      // Same idempotency key on retry → never a duplicate booking.
      setFailure("Network error — nothing is lost. Press Save again; it won’t create a duplicate.");
      return;
    }
    if (res.fieldErrors) setFieldErrors(Object.fromEntries(Object.entries(res.fieldErrors).map(([k, m]) => [k === "durationMinutes" ? "duration" : k, m[0]!])));
    setFailure(res.message);
  }

  const money = (c: number | null) => (c === null ? "—" : formatCents(c, options.currency));
  const activeCleanerIds = new Set(options.cleaners.map((c) => c.id));
  const cleanerChoices = [
    ...options.cleaners,
    ...(initial?.cleaners.filter((c) => !activeCleanerIds.has(c.id)).map((c) => ({ id: c.id, name: `${c.name} (inactive)`, phoneDisplay: c.phoneDisplay })) ?? []),
  ];

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {failure ? (
        <Alert tone="danger" title="Booking not saved">
          <p>{failure}</p>
          {conflicts && conflicts.length ? (
            <ul className="mt-2 list-disc pl-5">
              {conflicts.map((c) => (
                <li key={`${c.bookingId}-${c.cleanerId}`}>
                  {c.cleanerName}: {formatDateTime(c.start, options.timezone)} – {formatDateTime(c.end, options.timezone)} ({" "}
                  <Link href={`/dashboard/bookings/${c.bookingId}`} target="_blank" rel="noopener" className="underline">
                    {c.reference}
                  </Link>{" "}
                  )
                </li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
      {mode === "edit" && initial && initial.status !== "SCHEDULED" ? (
        <Alert tone="info" title="Some fields are locked">
          {initial.status === "IN_PROGRESS" ? "While a job is in progress you can change the assigned cleaners and notes." : "This job is finished; only office notes can be edited. Authorized users can reopen a completed job from its page."}
        </Alert>
      ) : null}

      <section className="space-y-4" aria-labelledby="bf-customer">
        <h2 id="bf-customer" className="text-base font-semibold">Customer and address</h2>
        {mode === "create" ? (
          <>
            <CustomerPicker
              value={customer}
              canCreate={options.canCreateCustomer}
              onChange={(c) => {
                setCustomer(c);
                setAddresses(null);
                setAddressId("");
                touch();
              }}
            />
            {fieldErrors.customer ? <p className="text-sm text-danger">{fieldErrors.customer}</p> : null}
            {customer ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Service address <span className="text-muted">(required)</span></legend>
                {addresses === null ? <p className="text-sm text-muted">Loading addresses…</p> : null}
                {addresses && addresses.length === 0 ? <p className="text-sm text-muted">This customer has no service address yet.</p> : null}
                {addresses?.map((a) => (
                  <label key={a.id} className="flex items-start gap-2 rounded-lg border border-line p-3 text-sm has-[:checked]:border-brand">
                    <input
                      type="radio"
                      name="address"
                      className="mt-0.5 accent-brand"
                      checked={addressId === a.id}
                      onChange={() => {
                        setAddressId(a.id);
                        touch();
                      }}
                    />
                    <span>
                      <span className="font-medium">{a.label || "Address"}</span>
                      {a.isPrimary ? <span className="text-muted"> (default)</span> : null}
                      <span className="block text-muted">{formatAddress(a)}</span>
                    </span>
                  </label>
                ))}
                {fieldErrors.addressId ? <p className="text-sm text-danger">{fieldErrors.addressId}</p> : null}
                {options.canCreateCustomer ? (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setAddingAddress(true)}>
                    <Plus className="size-4" aria-hidden /> New address
                  </Button>
                ) : null}
                {addingAddress ? (
                  <AddressDialog
                    customerId={customer.id}
                    open
                    isFirst={!addresses?.length}
                    onClose={() => setAddingAddress(false)}
                    onSaved={(a) => {
                      setAddresses((prev) => [...(prev ?? []).map((x) => (a.isPrimary ? { ...x, isPrimary: false } : x)), a]);
                      setAddressId(a.id);
                      touch();
                    }}
                  />
                ) : null}
              </fieldset>
            ) : null}
          </>
        ) : (
          <div className="rounded-lg border border-line bg-canvas p-3 text-sm">
            <p className="font-semibold">{initial!.customer.name}</p>
            <p className="text-muted">{formatAddress(initial!.address)}</p>
            <p className="mt-1 text-xs text-muted">To move a future booking to another address, use “Change address” on the booking page.</p>
          </div>
        )}
      </section>

      <section className="space-y-4" aria-labelledby="bf-when">
        <h2 id="bf-when" className="text-base font-semibold">When</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date" required error={fieldErrors.date}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="date"
                aria-describedby={describedBy}
                invalid={invalid}
                disabled={!editable.has("schedule")}
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setAmbiguous(null);
                  setDisambiguation(null);
                  touch();
                }}
              />
            )}
          </Field>
          <Field label="Start time" required hint={options.timezone} error={fieldErrors.startTime}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="time"
                step={900}
                aria-describedby={describedBy}
                invalid={invalid}
                disabled={!editable.has("schedule")}
                value={startTime}
                onChange={(e) => {
                  setStartTime(e.target.value);
                  setAmbiguous(null);
                  setDisambiguation(null);
                  touch();
                }}
              />
            )}
          </Field>
          <Field label="Duration (minutes)" required hint={estimatedMinutes ? `Services estimate: ${formatMinutes(estimatedMinutes)}` : undefined} error={fieldErrors.duration}>
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                inputMode="numeric"
                aria-describedby={describedBy}
                invalid={invalid}
                disabled={!editable.has("schedule")}
                value={duration}
                onChange={(e) => {
                  setDuration(e.target.value);
                  setDurationTouched(true);
                  touch();
                }}
              />
            )}
          </Field>
        </div>
        {ambiguous ? (
          <fieldset className="space-y-2 rounded-lg border border-pending/40 bg-pending-soft p-3 text-sm">
            <legend className="font-medium">This time happens twice (clocks go back). Which one?</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="dst" className="accent-brand" checked={disambiguation === "earlier"} onChange={() => setDisambiguation("earlier")} /> First occurrence (daylight time)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="dst" className="accent-brand" checked={disambiguation === "later"} onChange={() => setDisambiguation("later")} /> Second occurrence (standard time)
            </label>
          </fieldset>
        ) : null}
        {mode === "create" ? (
          <fieldset className="flex flex-wrap gap-4 text-sm">
            <legend className="mb-1 font-medium">Status</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="status" className="accent-brand" checked={status === "SCHEDULED"} onChange={() => setStatus("SCHEDULED")} /> Scheduled
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="status" className="accent-brand" checked={status === "COMPLETED"} onChange={() => setStatus("COMPLETED")} /> Already completed (record a past job)
            </label>
          </fieldset>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="bf-services">
        <h2 id="bf-services" className="text-base font-semibold">Services</h2>
        {options.services.length === 0 ? <Alert tone="pending" title="No active services">Add services to the catalog before booking.</Alert> : null}
        <ul className="space-y-3">
          {computed.map((l, i) => {
            const existing = Boolean(l.lineItemId);
            return (
              <li key={l.key} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-[1fr_6rem_8rem_auto] sm:items-end">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Service</span>
                  {existing ? (
                    <span className="block py-2">{l.name}</span>
                  ) : (
                    <Select
                      value={l.serviceId}
                      disabled={!editable.has("lineItems")}
                      onChange={(e) => updateLine(l.key, { serviceId: e.target.value, price: "" })}
                      aria-invalid={Boolean(fieldErrors[`line${i}`]) || undefined}
                    >
                      <option value="">Choose a service…</option>
                      {options.services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.defaultPriceCents !== null ? ` — ${formatCents(s.defaultPriceCents, s.currency)}/${s.unitLabel}` : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Qty ({l.unitLabel})</span>
                  <Input inputMode="numeric" value={l.quantity} disabled={!editable.has("lineItems")} onChange={(e) => updateLine(l.key, { quantity: e.target.value })} />
                </label>
                {options.canPrice ? (
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">Unit price</span>
                    {options.canOverride ? (
                      <Input
                        inputMode="decimal"
                        placeholder={l.unit !== null ? (l.unit / 100).toFixed(2) : ""}
                        value={l.price}
                        disabled={!editable.has("lineItems")}
                        onChange={(e) => updateLine(l.key, { price: e.target.value })}
                        aria-describedby={`price-hint-${l.key}`}
                      />
                    ) : (
                      <span className="block py-2 tabular-nums">{money(l.unit)}</span>
                    )}
                    <span id={`price-hint-${l.key}`} className="mt-1 block text-xs text-muted">
                      Line: {money(l.total)}
                    </span>
                  </label>
                ) : (
                  <span />
                )}
                {editable.has("lineItems") ? (
                  <Button type="button" variant="ghost" size="sm" className="h-11" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove service ${i + 1}`}>
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                ) : null}
                {fieldErrors[`line${i}`] ? <p className="text-sm text-danger sm:col-span-4">{fieldErrors[`line${i}`]}</p> : null}
              </li>
            );
          })}
        </ul>
        {editable.has("lineItems") ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, { key: newLineKey(), serviceId: "", quantity: "1", price: "", catalogPrice: null, durationMinutes: 0 }])}>
            <Plus className="size-4" aria-hidden /> Add service
          </Button>
        ) : null}
        {options.canPrice ? (
          <p className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-3 text-sm">
            <span>
              <span className="font-semibold">Service subtotal</span> <span className="text-muted">(preview; no taxes or discounts — the server calculates the saved amount)</span>
            </span>
            <span className="text-lg font-semibold tabular-nums">{money(subtotal)}</span>
          </p>
        ) : null}
      </section>

      <section className="space-y-3" aria-labelledby="bf-cleaners">
        <h2 id="bf-cleaners" className="text-base font-semibold">Assigned cleaners</h2>
        <p className="text-sm text-muted">Optional. Leave empty to keep the job “Unassigned”. Overlapping jobs for the same cleaner are blocked.</p>
        {cleanerChoices.length === 0 ? <p className="text-sm text-muted">No active cleaners.</p> : null}
        <div className="grid gap-2 sm:grid-cols-2">
          {cleanerChoices.map((c) => (
            <label key={c.id} className="flex items-center gap-2 rounded-lg border border-line p-2.5 text-sm has-[:checked]:border-brand">
              <input
                type="checkbox"
                className="size-4 accent-brand"
                disabled={!editable.has("cleaners")}
                checked={cleanerIds.includes(c.id)}
                onChange={(e) => {
                  setCleanerIds((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id)));
                  touch();
                }}
              />
              {c.name}
            </label>
          ))}
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2" aria-label="Notes">
        <Field label="Job instructions" hint="Visible to the assigned cleaners">
          {({ id, describedBy }) => (
            <textarea id={id} aria-describedby={describedBy} rows={3} maxLength={5000} disabled={!editable.has("instructions")} value={instructions} onChange={(e) => { setInstructions(e.target.value); touch(); }} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base disabled:bg-canvas sm:text-sm" />
          )}
        </Field>
        <Field label="Office notes" hint="Internal only — never shown to cleaners">
          {({ id, describedBy }) => (
            <textarea id={id} aria-describedby={describedBy} rows={3} maxLength={5000} disabled={!editable.has("officeNotes")} value={officeNotes} onChange={(e) => { setOfficeNotes(e.target.value); touch(); }} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base disabled:bg-canvas sm:text-sm" />
          )}
        </Field>
      </section>

      {editable.has("officeNotes") ? <CustomFieldInputs defs={cfDefs} values={cf} errors={fieldErrors} onChange={(k, val) => { setCf((prev) => ({ ...prev, [k]: val })); touch(); }} /> : null}

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        <Button type="button" variant="secondary" onClick={() => (initial ? router.push(`/dashboard/bookings/${initial.id}`) : router.back())}>
          Cancel
        </Button>
        <Button type="submit" loading={saving} disabled={options.services.length === 0 && mode === "create"}>
          {mode === "create" ? "Create booking" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
