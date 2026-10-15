"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { useUnsavedChangesWarning } from "@/lib/client/hooks";
import { CONTACT_SOURCE_LABELS, CONTACT_SOURCES, CUSTOMER_TYPE_LABELS, CUSTOMER_TYPES, type ContactSource, type CustomerType } from "@/lib/domain/constants";
import { createCustomerSchema, updateCustomerSchema } from "@/modules/customers/schemas";
import { AddressFields, addressErrors, addressPayload, EMPTY_ADDRESS, type AddressFormValue } from "./address-fields";

export type CustomerFormInitial = {
  id?: string;
  customerType: CustomerType;
  firstName: string;
  lastName: string;
  displayName: string;
  companyName: string;
  phone: string;
  email: string;
  relationshipStartedAt: string;
  contactSource: ContactSource | "";
  tags: string[];
  notes: string;
};

export const EMPTY_CUSTOMER: CustomerFormInitial = {
  customerType: "individual",
  firstName: "",
  lastName: "",
  displayName: "",
  companyName: "",
  phone: "",
  email: "",
  relationshipStartedAt: "",
  contactSource: "",
  tags: [],
  notes: "",
};

type Duplicate = { id: string; name: string; phoneDisplay: string | null; email: string | null; primaryCity: string | null; archived: boolean; matchedOn: string[] };
export type CreatedCustomer = { id: string; name: string; phoneDisplay: string | null; email: string | null; primaryCity: string | null };

const PHONE_COUNTRIES = [
  ["CA", "Canada (+1)"],
  ["US", "United States (+1)"],
  ["FR", "France (+33)"],
  ["GB", "United Kingdom (+44)"],
  ["MX", "Mexico (+52)"],
  ["MA", "Morocco (+212)"],
  ["DZ", "Algeria (+213)"],
] as const;

/**
 * Create/edit form. In create mode an optional primary service address is
 * included and possible duplicates are shown before saving. `onCreated` lets
 * callers (e.g. the booking form) keep the user in place.
 */
export function CustomerForm({ mode, initial = EMPTY_CUSTOMER, onCreated, onCancel }: { mode: "create" | "edit"; initial?: CustomerFormInitial; onCreated?: (c: CreatedCustomer) => void; onCancel?: () => void }) {
  const router = useRouter();
  const [v, setV] = useState<CustomerFormInitial>(initial);
  const [phoneCountry, setPhoneCountry] = useState("CA");
  const [tagsText, setTagsText] = useState(initial.tags.join(", "));
  const [withAddress, setWithAddress] = useState(mode === "create");
  const [address, setAddress] = useState<AddressFormValue>(EMPTY_ADDRESS);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedChangesWarning(dirty && !saving);

  const update = <K extends keyof CustomerFormInitial>(k: K, val: CustomerFormInitial[K]) => {
    setV((prev) => ({ ...prev, [k]: val }));
    setDirty(true);
  };

  const payload = useMemo(() => {
    const base = {
      customerType: v.customerType,
      firstName: v.firstName,
      lastName: v.lastName,
      displayName: v.displayName,
      companyName: v.companyName,
      phone: v.phone,
      phoneCountry,
      email: v.email,
      relationshipStartedAt: v.relationshipStartedAt,
      contactSource: v.contactSource,
      tags: tagsText.split(",").map((t) => t.trim()).filter(Boolean),
      notes: v.notes,
    };
    return mode === "create" && withAddress ? { ...base, primaryAddress: addressPayload({ ...address, isPrimary: true }) } : base;
  }, [v, phoneCountry, tagsText, mode, withAddress, address]);

  async function submit(confirmDuplicate = false) {
    setFailure(null);
    // Inline validation with the same schema the server uses.
    const parsed = (mode === "create" ? createCustomerSchema : updateCustomerSchema).safeParse(mode === "create" ? { ...payload, confirmDuplicate } : payload);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[issue.path.join(".")] ??= issue.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    setSaving(true);
    const res =
      mode === "create"
        ? await apiRequest<CreatedCustomer>("/api/v1/customers", { method: "POST", body: { ...payload, confirmDuplicate } })
        : await apiRequest<CreatedCustomer>(`/api/v1/customers/${initial.id}`, { method: "PATCH", body: payload });
    setSaving(false);
    if (res.ok) {
      setDirty(false);
      setDuplicates(null);
      if (onCreated) onCreated(res.data);
      else {
        router.push(`/dashboard/customers/${res.data.id}`);
        router.refresh();
      }
      return;
    }
    if (res.code === "POSSIBLE_DUPLICATES") {
      setDuplicates((res.details?.matches as Duplicate[]) ?? []);
      return;
    }
    if (res.fieldErrors) {
      const errs: Record<string, string> = {};
      for (const [k, msgs] of Object.entries(res.fieldErrors)) errs[k] = msgs[0]!;
      setErrors(errs);
    }
    setFailure(res.message);
  }

  const individual = v.customerType === "individual";
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
      className="space-y-6"
    >
      {failure ? <Alert tone="danger" title="Customer not saved">{failure}</Alert> : null}

      {duplicates ? (
        <Alert tone="pending" title="Possible duplicates found">
          <p>These customers share a phone number, email or name. Shared contact details are fine (households, businesses) — continue only if this is a different customer.</p>
          <ul className="mt-2 space-y-1">
            {duplicates.map((d) => (
              <li key={d.id}>
                <Link href={`/dashboard/customers/${d.id}`} target="_blank" rel="noopener" className="font-medium text-brand underline">
                  {d.name}
                </Link>{" "}
                <span className="text-muted">
                  {[d.phoneDisplay, d.email, d.primaryCity].filter(Boolean).join(" · ")} — same {d.matchedOn.join(" and ")}
                  {d.archived ? " (archived)" : ""}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" loading={saving} onClick={() => void submit(true)}>
              Create anyway
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setDuplicates(null)}>
              Keep editing
            </Button>
          </div>
        </Alert>
      ) : null}

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Customer</legend>
        <Field label="Customer type">
          {({ id }) => (
            <Select id={id} value={v.customerType} onChange={(e) => update("customerType", e.target.value as CustomerType)}>
              {CUSTOMER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CUSTOMER_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="hidden sm:block" />
        {individual ? (
          <>
            <Field label="First name" required error={errors.firstName}>
              {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} autoComplete="off" value={v.firstName} onChange={(e) => update("firstName", e.target.value)} maxLength={80} />}
            </Field>
            <Field label="Last name">
              {({ id }) => <Input id={id} autoComplete="off" value={v.lastName} onChange={(e) => update("lastName", e.target.value)} maxLength={80} />}
            </Field>
          </>
        ) : (
          <Field label="Display name" required hint="Shown everywhere, e.g. the business name" error={errors.displayName}>
            {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} value={v.displayName} onChange={(e) => update("displayName", e.target.value)} maxLength={160} />}
          </Field>
        )}
        <Field label="Company (optional)">
          {({ id }) => <Input id={id} value={v.companyName} onChange={(e) => update("companyName", e.target.value)} maxLength={160} />}
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Contact</legend>
        <p className="text-sm text-muted sm:col-span-2">Add at least a phone number or an email address. Email is optional.</p>
        <div className="grid grid-cols-[minmax(0,9rem)_1fr] gap-2">
          <Field label="Country">
            {({ id }) => (
              <Select id={id} value={phoneCountry} onChange={(e) => setPhoneCountry(e.target.value)}>
                {PHONE_COUNTRIES.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Phone" hint="Other countries: start with +" error={errors.phone}>
            {({ id, describedBy, invalid }) => <Input id={id} type="tel" autoComplete="off" aria-describedby={describedBy} invalid={invalid} value={v.phone} onChange={(e) => update("phone", e.target.value)} maxLength={40} />}
          </Field>
        </div>
        <Field label="Email" error={errors.email}>
          {({ id, describedBy, invalid }) => <Input id={id} type="email" autoComplete="off" aria-describedby={describedBy} invalid={invalid} value={v.email} onChange={(e) => update("email", e.target.value)} maxLength={254} />}
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Relationship</legend>
        <Field label="Customer since" hint="Used for relationship duration. Leave blank if unknown." error={errors.relationshipStartedAt}>
          {({ id, describedBy, invalid }) => <Input id={id} type="date" aria-describedby={describedBy} invalid={invalid} value={v.relationshipStartedAt} onChange={(e) => update("relationshipStartedAt", e.target.value)} />}
        </Field>
        <Field label="Contact source">
          {({ id }) => (
            <Select id={id} value={v.contactSource} onChange={(e) => update("contactSource", e.target.value as ContactSource | "")}>
              <option value="">Not specified</option>
              {CONTACT_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {CONTACT_SOURCE_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Tags" hint="Separate with commas, e.g. VIP, pets, weekly" error={errors.tags}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              value={tagsText}
              onChange={(e) => {
                setTagsText(e.target.value);
                setDirty(true);
              }}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field label="Internal notes" hint="Office only. Never shown to cleaners.">
            {({ id, describedBy }) => (
              <textarea id={id} aria-describedby={describedBy} rows={3} maxLength={5000} value={v.notes} onChange={(e) => update("notes", e.target.value)} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm" />
            )}
          </Field>
        </div>
      </fieldset>

      {mode === "create" ? (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">Primary service address</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand" checked={withAddress} onChange={(e) => setWithAddress(e.target.checked)} />
            Add the service address now
          </label>
          {withAddress ? (
            <AddressFields
              value={address}
              onChange={(a) => {
                setAddress(a);
                setDirty(true);
              }}
              errors={addressErrors(Object.fromEntries(Object.entries(errors).map(([k, m]) => [k, [m ?? ""]])), "primaryAddress")}
              showPrimary={false}
              idPrefix="primary"
            />
          ) : null}
        </fieldset>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" loading={saving}>
          {mode === "create" ? "Create customer" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
