"use client";

import { Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { parseAmountToCents } from "@/lib/domain/money";
import type { ServiceDTO } from "@/modules/catalog/service";

type FormState = { name: string; description: string; category: string; price: string; durationMinutes: string; unitLabel: string; active: boolean };

function toForm(s?: ServiceDTO | null): FormState {
  return {
    name: s?.name ?? "",
    description: s?.description ?? "",
    category: s?.category ?? "",
    price: s && s.defaultPriceCents !== null ? (s.defaultPriceCents / 100).toFixed(2) : "",
    durationMinutes: s ? String(s.durationMinutes) : "60",
    unitLabel: s?.unitLabel ?? "item",
    active: s?.active ?? true,
  };
}

/** Create/edit dialog. Prices are entered as decimals and stored as integer cents. */
export function ServiceDialog({ service, currency, onClose }: { service: ServiceDTO | null; currency: string; onClose: () => void }) {
  const router = useRouter();
  const [v, setV] = useState<FormState>(toForm(service));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    const cents = parseAmountToCents(v.price);
    const minutes = Number(v.durationMinutes);
    const errs: Record<string, string> = {};
    if (!v.name.trim()) errs.name = "Name is required";
    if (cents === null || cents < 0) errs.price = "Enter a price like 120 or 120.50";
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) errs.durationMinutes = "Whole minutes between 0 and 1440";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    setFailure(null);
    const body = { name: v.name, description: v.description, category: v.category, defaultPriceCents: cents, durationMinutes: minutes, unitLabel: v.unitLabel || "item", active: v.active };
    const res = service ? await apiRequest(`/api/v1/services/${service.id}`, { method: "PATCH", body }) : await apiRequest("/api/v1/services", { method: "POST", body });
    setSaving(false);
    if (!res.ok) {
      setFailure(res.message);
      return;
    }
    router.refresh();
    onClose();
  }

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <Modal title={service ? `Edit ${service.name}` : "New service"} open onClose={onClose}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {failure ? <Alert tone="danger" title="Service not saved">{failure}</Alert> : null}
        {service ? <Alert tone="info" title="Existing bookings keep their prices">Changes apply to new booking items only.</Alert> : null}
        <Field label="Name" required error={errors.name}>
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} value={v.name} onChange={set("name")} maxLength={120} />}
        </Field>
        <Field label="Category" hint="Optional, e.g. Upholstery">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={v.category} onChange={set("category")} maxLength={60} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={`Unit price (${currency})`} required error={errors.price}>
            {({ id, describedBy, invalid }) => <Input id={id} inputMode="decimal" aria-describedby={describedBy} invalid={invalid} value={v.price} onChange={set("price")} />}
          </Field>
          <Field label="Unit" hint="item, room, visit, hour">
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={v.unitLabel} onChange={set("unitLabel")} maxLength={30} />}
          </Field>
          <Field label="Duration (minutes)" required hint="Per unit, estimated" error={errors.durationMinutes}>
            {({ id, describedBy, invalid }) => <Input id={id} inputMode="numeric" aria-describedby={describedBy} invalid={invalid} value={v.durationMinutes} onChange={set("durationMinutes")} />}
          </Field>
        </div>
        <Field label="Description">
          {({ id }) => <textarea id={id} rows={3} maxLength={2000} value={v.description} onChange={set("description")} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm" />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-brand" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} />
          Active (can be added to new bookings)
        </label>
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Save service
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function NewServiceButton({ currency }: { currency: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden /> New service
      </Button>
      {open ? <ServiceDialog service={null} currency={currency} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function ServiceRowActions({ service, currency }: { service: ServiceDTO; currency: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} aria-label={`Edit ${service.name}`}>
        <Pencil className="size-4" aria-hidden /> Edit
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const res = await apiRequest(`/api/v1/services/${service.id}`, { method: "PATCH", body: { active: !service.active } });
          setBusy(false);
          if (!res.ok) setError(res.message);
          router.refresh();
        }}
      >
        {service.active ? "Deactivate" : "Activate"}
      </Button>
      {error ? <p role="alert" className="w-full text-right text-xs text-danger">{error}</p> : null}
      {open ? <ServiceDialog service={service} currency={currency} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
