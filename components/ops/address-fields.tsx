"use client";

import { Plus, Trash2 } from "lucide-react";
import { Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";

export type AddressFormValue = {
  label: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  lat: string;
  lng: string;
  accessInstructions: string;
  isPrimary: boolean;
  links: { label: string; url: string }[];
};

export const EMPTY_ADDRESS: AddressFormValue = {
  label: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "Canada",
  lat: "",
  lng: "",
  accessInstructions: "",
  isPrimary: true,
  links: [],
};

/** Converts form strings to the API's address payload. */
export function addressPayload(v: AddressFormValue) {
  const lat = v.lat.trim() === "" ? null : Number(v.lat);
  const lng = v.lng.trim() === "" ? null : Number(v.lng);
  return {
    label: v.label,
    line1: v.line1,
    line2: v.line2,
    city: v.city,
    region: v.region,
    postalCode: v.postalCode,
    country: v.country,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    accessInstructions: v.accessInstructions,
    isPrimary: v.isPrimary,
    links: v.links.filter((l) => l.label.trim() || l.url.trim()),
  };
}

/** Controlled address inputs. `errors` keys match the API's field names (e.g. "line1", "links.0.url"). */
export function AddressFields({
  value,
  onChange,
  errors = {},
  showPrimary = true,
  idPrefix = "addr",
}: {
  value: AddressFormValue;
  onChange: (v: AddressFormValue) => void;
  errors?: Record<string, string | undefined>;
  showPrimary?: boolean;
  idPrefix?: string;
}) {
  const set = (k: keyof AddressFormValue) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Label" hint="For example Home, Office, Rental property">
        {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={value.label} onChange={set("label")} maxLength={80} />}
      </Field>
      <Field label="Street address" required error={errors.line1}>
        {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} autoComplete="address-line1" value={value.line1} onChange={set("line1")} maxLength={200} />}
      </Field>
      <Field label="Unit, suite, floor">
        {({ id }) => <Input id={id} autoComplete="address-line2" value={value.line2} onChange={set("line2")} maxLength={200} />}
      </Field>
      <Field label="City" required error={errors.city}>
        {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} autoComplete="address-level2" value={value.city} onChange={set("city")} maxLength={100} />}
      </Field>
      <Field label="Province / state">
        {({ id }) => <Input id={id} autoComplete="address-level1" value={value.region} onChange={set("region")} maxLength={100} />}
      </Field>
      <Field label="Postal code">
        {({ id }) => <Input id={id} autoComplete="postal-code" value={value.postalCode} onChange={set("postalCode")} maxLength={20} />}
      </Field>
      <Field label="Country">
        {({ id }) => <Input id={id} autoComplete="country-name" value={value.country} onChange={set("country")} maxLength={100} />}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Latitude" hint="Optional" error={errors.lat}>
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} inputMode="decimal" value={value.lat} onChange={set("lat")} />}
        </Field>
        <Field label="Longitude" hint="Optional">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} inputMode="decimal" value={value.lng} onChange={set("lng")} />}
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Access and parking instructions" hint="Visible to office staff and the cleaners assigned to a job here.">
          {({ id, describedBy }) => (
            <textarea
              id={id}
              aria-describedby={describedBy}
              rows={2}
              maxLength={2000}
              value={value.accessInstructions}
              onChange={set("accessInstructions")}
              className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm"
            />
          )}
        </Field>
      </div>
      <fieldset className="space-y-2 sm:col-span-2">
        <legend className="text-sm font-medium">Links (optional)</legend>
        <p className="text-xs text-muted">Property listing, building website, etc. Only http(s) links are accepted.</p>
        {value.links.map((l, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
            <Input aria-label={`Link ${i + 1} label`} placeholder="Label" value={l.label} maxLength={80} onChange={(e) => onChange({ ...value, links: value.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <Input
              aria-label={`Link ${i + 1} URL`}
              placeholder="https://"
              type="url"
              invalid={Boolean(errors[`links.${i}.url`])}
              value={l.url}
              maxLength={2000}
              onChange={(e) => onChange({ ...value, links: value.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })}
            />
            <Button type="button" variant="ghost" size="sm" className="h-11" onClick={() => onChange({ ...value, links: value.links.filter((_, j) => j !== i) })} aria-label={`Remove link ${i + 1}`}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
            {errors[`links.${i}.url`] ? <p className="text-sm text-danger sm:col-span-3">{errors[`links.${i}.url`]}</p> : null}
          </div>
        ))}
        {value.links.length < 5 ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => onChange({ ...value, links: [...value.links, { label: "", url: "" }] })}>
            <Plus className="size-4" aria-hidden /> Add link
          </Button>
        ) : null}
      </fieldset>
      {showPrimary ? (
        <label className="flex items-center gap-2 text-sm sm:col-span-2" htmlFor={`${idPrefix}-primary`}>
          <input id={`${idPrefix}-primary`} type="checkbox" className="size-4 accent-brand" checked={value.isPrimary} onChange={(e) => onChange({ ...value, isPrimary: e.target.checked })} />
          Default address for new bookings
        </label>
      ) : null}
    </div>
  );
}

/** Flattens API fieldErrors ({ "primaryAddress.line1": [...] }) for a nested prefix. */
export function addressErrors(fieldErrors: Record<string, string[]> | undefined, prefix = ""): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(fieldErrors ?? {})) {
    if (prefix && !k.startsWith(`${prefix}.`)) continue;
    out[prefix ? k.slice(prefix.length + 1) : k] = v[0];
  }
  return out;
}
