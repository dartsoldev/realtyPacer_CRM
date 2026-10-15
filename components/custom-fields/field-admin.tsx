"use client";

import { Archive, ArchiveRestore, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { CUSTOM_FIELD_TYPE_LABELS, CUSTOM_FIELD_TYPES, FILTERABLE_CUSTOM_FIELD_TYPES, type CustomFieldEntity, type CustomFieldType } from "@/lib/domain/constants";
import type { CustomFieldDef } from "@/modules/custom-fields/service";

type Draft = {
  label: string;
  dataType: CustomFieldType;
  options: { value?: string; label: string; archived: boolean }[];
  required: boolean;
  showInTable: boolean;
  filterable: boolean;
  indexed: boolean;
  visibility: "office" | "assigned_cleaners";
  maxLength: string;
  min: string;
  max: string;
  integer: boolean;
};

const toDraft = (d?: CustomFieldDef): Draft => ({
  label: d?.label ?? "",
  dataType: d?.dataType ?? "short_text",
  options: d?.options.map((o) => ({ ...o })) ?? [],
  required: d?.required ?? false,
  showInTable: d?.showInTable ?? false,
  filterable: d?.filterable ?? false,
  indexed: d?.indexed ?? false,
  visibility: d?.visibility ?? "office",
  maxLength: d?.validation.maxLength != null ? String(d.validation.maxLength) : "",
  min: d?.validation.min != null ? String(d.validation.min) : "",
  max: d?.validation.max != null ? String(d.validation.max) : "",
  integer: d?.validation.integer ?? false,
});

function FieldDialog({ entity, def, onClose }: { entity: CustomFieldEntity; def?: CustomFieldDef; onClose: () => void }) {
  const router = useRouter();
  const [v, setV] = useState<Draft>(toDraft(def));
  const [newOption, setNewOption] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSelect = v.dataType === "single_select" || v.dataType === "multi_select";
  const canFilter = FILTERABLE_CUSTOM_FIELD_TYPES.includes(v.dataType);
  const set = <K extends keyof Draft>(k: K, val: Draft[K]) => setV((p) => ({ ...p, [k]: val }));
  const num = (s: string) => (s.trim() === "" ? null : Number(s));

  async function save() {
    setBusy(true);
    setError(null);
    const validation =
      v.dataType === "number" ? { min: num(v.min), max: num(v.max), integer: v.integer } : v.dataType === "short_text" || v.dataType === "long_text" ? { maxLength: num(v.maxLength) } : {};
    const body: Record<string, unknown> = {
      label: v.label,
      options: isSelect ? v.options.map((o) => (o.value ? { value: o.value, label: o.label, archived: o.archived } : { label: o.label, archived: o.archived })) : [],
      validation,
      required: v.required,
      showInTable: v.showInTable,
      filterable: canFilter && v.filterable,
      indexed: canFilter && v.filterable && v.indexed,
      visibility: entity === "booking" ? v.visibility : "office",
    };
    if (!def || v.dataType !== def.dataType) body.dataType = v.dataType;
    const res = def ? await apiRequest(`/api/v1/custom-fields/${def.id}`, { method: "PATCH", body }) : await apiRequest("/api/v1/custom-fields", { method: "POST", body: { ...body, entityType: entity, dataType: v.dataType } });
    setBusy(false);
    if (!res.ok) return setError(res.code === "TYPE_CHANGE_BLOCKED" ? "The type can't change because records already have values. Create a new field instead and archive this one." : res.message);
    router.refresh();
    onClose();
  }

  return (
    <Modal title={def ? `Edit “${def.label}”` : "New custom field"} open onClose={onClose} wide>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label" required hint={def ? `Storage key ${def.key} never changes, so renaming keeps all values.` : "A safe storage key is generated automatically."}>
            {(p) => <Input {...p} data-autofocus value={v.label} onChange={(e) => set("label", e.target.value)} maxLength={80} required />}
          </Field>
          <Field label="Type" required hint={def ? "Changing type is only possible while no record has a value." : undefined}>
            {(p) => (
              <Select {...p} value={v.dataType} onChange={(e) => set("dataType", e.target.value as CustomFieldType)}>
                {CUSTOM_FIELD_TYPES.map((t) => <option key={t} value={t}>{CUSTOM_FIELD_TYPE_LABELS[t]}</option>)}
              </Select>
            )}
          </Field>
        </div>
        {isSelect ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Options</legend>
            <p className="text-xs text-muted">Options can be renamed or retired, never deleted, so existing answers keep their meaning.</p>
            <ul className="space-y-2">
              {v.options.map((o, i) => (
                <li key={o.value ?? `new-${i}`} className="flex items-center gap-2">
                  <Input aria-label={`Option ${i + 1} label`} value={o.label} onChange={(e) => set("options", v.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} maxLength={80} className="h-9" />
                  {o.value ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => set("options", v.options.map((x, j) => (j === i ? { ...x, archived: !x.archived } : x)))}>
                      {o.archived ? "Restore" : "Retire"}
                    </Button>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" onClick={() => set("options", v.options.filter((_, j) => j !== i))}>Remove</Button>
                  )}
                  {o.archived ? <Badge tone="slate">Retired</Badge> : null}
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Input aria-label="New option" placeholder="New option" value={newOption} onChange={(e) => setNewOption(e.target.value)} maxLength={80} className="h-9" />
              <Button type="button" variant="secondary" size="sm" disabled={!newOption.trim()} onClick={() => { set("options", [...v.options, { label: newOption.trim(), archived: false }]); setNewOption(""); }}>Add</Button>
            </div>
          </fieldset>
        ) : null}
        {v.dataType === "number" ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Minimum">{(p) => <Input {...p} inputMode="decimal" value={v.min} onChange={(e) => set("min", e.target.value)} />}</Field>
            <Field label="Maximum">{(p) => <Input {...p} inputMode="decimal" value={v.max} onChange={(e) => set("max", e.target.value)} />}</Field>
            <label className="flex items-center gap-2 self-end pb-3 text-sm"><input type="checkbox" className="size-4 accent-brand" checked={v.integer} onChange={(e) => set("integer", e.target.checked)} /> Whole numbers only</label>
          </div>
        ) : null}
        {v.dataType === "short_text" || v.dataType === "long_text" ? (
          <Field label="Maximum length">{(p) => <Input {...p} inputMode="numeric" value={v.maxLength} onChange={(e) => set("maxLength", e.target.value)} placeholder={v.dataType === "short_text" ? "200" : "2000"} />}</Field>
        ) : null}
        <fieldset className="grid gap-2 text-sm sm:grid-cols-2">
          <legend className="mb-1 font-medium">Behaviour</legend>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={v.required} onChange={(e) => set("required", e.target.checked)} /> <span>Required for new records<span className="block text-xs text-muted">Existing records stay valid; find gaps with the “is empty” filter.</span></span></label>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={v.showInTable} onChange={(e) => set("showInTable", e.target.checked)} /> <span>Show as a list column</span></label>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 size-4 accent-brand" disabled={!canFilter} checked={canFilter && v.filterable} onChange={(e) => set("filterable", e.target.checked)} /> <span>Use in filters and reports{!canFilter ? <span className="block text-xs text-muted">Not available for long text or links.</span> : null}</span></label>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5 size-4 accent-brand" disabled={!canFilter || !v.filterable} checked={canFilter && v.filterable && v.indexed} onChange={(e) => set("indexed", e.target.checked)} /> <span>Speed up filtering (index)<span className="block text-xs text-muted">At most 5 per record type. Applied by the next index sync.</span></span></label>
        </fieldset>
        {entity === "booking" ? (
          <Field label="Who can see values">
            {(p) => (
              <Select {...p} value={v.visibility} onChange={(e) => set("visibility", e.target.value as Draft["visibility"])}>
                <option value="office">Office only</option>
                <option value="assigned_cleaners">Office and assigned cleaners</option>
              </Select>
            )}
          </Field>
        ) : null}
        {error ? <Alert tone="danger" title="Not saved">{error}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy} disabled={!v.label.trim()}>Save field</Button>
        </div>
      </form>
    </Modal>
  );
}

export function NewFieldButton({ entity }: { entity: CustomFieldEntity }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden /> New field
      </Button>
      {open ? <FieldDialog entity={entity} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function FieldRowActions({ def }: { def: CustomFieldDef }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggleArchive() {
    if (!def.archived && !window.confirm(`Archive “${def.label}”? Values are kept but hidden from forms, lists and new filters. You can restore it later.`)) return;
    setBusy(true);
    const res = await apiRequest(`/api/v1/custom-fields/${def.id}`, { method: "PATCH", body: { archived: !def.archived } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    router.refresh();
  }
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {!def.archived ? (
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          <Pencil className="size-4" aria-hidden /> Edit
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" loading={busy} onClick={() => void toggleArchive()}>
        {def.archived ? <ArchiveRestore className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />} {def.archived ? "Restore" : "Archive"}
      </Button>
      {error ? <p className="w-full text-right text-xs text-danger">{error}</p> : null}
      {editing ? <FieldDialog entity={def.entityType} def={def} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}
