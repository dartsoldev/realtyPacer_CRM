"use client";

import { useEffect, useState } from "react";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import type { CustomFieldDef } from "@/modules/custom-fields/service";

export type CustomFieldDraft = Record<string, unknown>;

/** Definitions passed from the server, or fetched when a form is used inline (e.g. inside a dialog). */
export function useCustomFieldDefs(entity: "customer" | "booking" | "cleaner", provided?: CustomFieldDef[]): CustomFieldDef[] {
  const [fetched, setFetched] = useState<CustomFieldDef[]>([]);
  useEffect(() => {
    if (provided) return;
    let cancelled = false;
    void apiRequest<{ items: CustomFieldDef[] }>(`/api/v1/custom-fields?entity=${entity}`).then((r) => {
      if (!cancelled && r.ok) setFetched(r.data.items);
    });
    return () => {
      cancelled = true;
    };
  }, [entity, provided]);
  return provided ?? fetched;
}

/** Only the values that changed, with cleared fields as null (the server drops them). */
export function changedCustomFields(defs: CustomFieldDef[], initial: Record<string, unknown>, draft: CustomFieldDraft): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    if (d.archived || !(d.key in draft)) continue;
    const before = initial[d.key] ?? null;
    let after = draft[d.key];
    if (after === "" || (Array.isArray(after) && after.length === 0)) after = null;
    if (d.dataType === "number" && typeof after === "string") after = after.trim() === "" ? null : Number(after);
    if (JSON.stringify(before) !== JSON.stringify(after ?? null)) out[d.key] = after ?? null;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Inputs for the active custom fields of one entity. Archived fields are not editable. */
export function CustomFieldInputs({ defs, values, onChange, errors }: { defs: CustomFieldDef[]; values: CustomFieldDraft; onChange: (key: string, value: unknown) => void; errors?: Record<string, string | undefined> }) {
  const active = defs.filter((d) => !d.archived);
  if (active.length === 0) return null;
  return (
    <fieldset className="space-y-4">
      <legend className="text-base font-semibold">Additional details</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        {active.map((d) => {
          const v = values[d.key];
          const err = errors?.[`customFields.${d.key}`];
          const hint = d.visibility === "assigned_cleaners" ? "Visible to assigned cleaners" : undefined;
          if (d.dataType === "boolean") {
            return (
              <Field key={d.key} label={d.label} required={d.required} error={err} hint={hint}>
                {(p) => (
                  <Select {...p} value={v === true ? "yes" : v === false ? "no" : ""} onChange={(e) => onChange(d.key, e.target.value === "" ? null : e.target.value === "yes")}>
                    <option value="">Not set</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </Select>
                )}
              </Field>
            );
          }
          if (d.dataType === "single_select") {
            return (
              <Field key={d.key} label={d.label} required={d.required} error={err} hint={hint}>
                {(p) => (
                  <Select {...p} value={typeof v === "string" ? v : ""} onChange={(e) => onChange(d.key, e.target.value || null)}>
                    <option value="">Not set</option>
                    {d.options.filter((o) => !o.archived || o.value === v).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}{o.archived ? " (retired)" : ""}</option>
                    ))}
                  </Select>
                )}
              </Field>
            );
          }
          if (d.dataType === "multi_select") {
            const selected = Array.isArray(v) ? (v as string[]) : [];
            return (
              <fieldset key={d.key} className="space-y-1.5">
                <legend className="text-sm font-medium">{d.label}{d.required ? <span className="text-muted"> (required)</span> : null}</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {d.options.filter((o) => !o.archived || selected.includes(o.value)).map((o) => (
                    <label key={o.value} className="inline-flex items-center gap-2 text-sm">
                      <input type="checkbox" className="size-4 accent-brand" checked={selected.includes(o.value)} onChange={(e) => onChange(d.key, e.target.checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))} />
                      {o.label}
                    </label>
                  ))}
                </div>
                {err ? <p className="text-sm text-danger">{err}</p> : null}
              </fieldset>
            );
          }
          if (d.dataType === "long_text") {
            return (
              <div key={d.key} className="sm:col-span-2">
                <Field label={d.label} required={d.required} error={err} hint={hint}>
                  {(p) => <textarea id={p.id} aria-describedby={p.describedBy} rows={3} maxLength={d.validation.maxLength ?? 2000} value={typeof v === "string" ? v : ""} onChange={(e) => onChange(d.key, e.target.value)} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm" />}
                </Field>
              </div>
            );
          }
          const type = d.dataType === "number" ? "number" : d.dataType === "date" ? "date" : d.dataType === "url" ? "url" : "text";
          return (
            <Field key={d.key} label={d.label} required={d.required} error={err} hint={hint}>
              {(p) => (
                <Input
                  {...p}
                  type={type}
                  step={d.dataType === "number" ? (d.validation.integer ? 1 : "any") : undefined}
                  min={d.validation.min ?? undefined}
                  max={d.validation.max ?? undefined}
                  maxLength={d.dataType === "short_text" ? (d.validation.maxLength ?? 200) : undefined}
                  value={v === null || v === undefined ? "" : String(v)}
                  onChange={(e) => onChange(d.key, e.target.value)}
                />
              )}
            </Field>
          );
        })}
      </div>
    </fieldset>
  );
}
