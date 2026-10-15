"use client";

import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Card, CardHeader } from "@/components/ui/layout";
import { apiRequest } from "@/lib/client/api";
import type { OrganizationSettings } from "@/modules/organization/service";

type Values = {
  name: string;
  displayName: string;
  timezone: string;
  currency: string;
  contact: Record<string, string>;
  terminology: { customer: string; booking: string; provider: string };
};

const CONTACT_FIELDS: Array<{ key: string; label: string; type?: string; autoComplete?: string }> = [
  { key: "email", label: "Business email", type: "email", autoComplete: "email" },
  { key: "phone", label: "Business phone", type: "tel", autoComplete: "tel" },
  { key: "website", label: "Website", type: "url", autoComplete: "url" },
  { key: "addressLine1", label: "Street address", autoComplete: "address-line1" },
  { key: "city", label: "City", autoComplete: "address-level2" },
  { key: "region", label: "Province / state", autoComplete: "address-level1" },
  { key: "postalCode", label: "Postal code", autoComplete: "postal-code" },
  { key: "country", label: "Country", autoComplete: "country-name" },
  { key: "serviceArea", label: "Service area", autoComplete: "off" },
];

export function OrganizationForm({ settings, canEdit, canEditProtected }: { settings: OrganizationSettings; canEdit: boolean; canEditProtected: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; title: string; body?: string } | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values>({
    defaultValues: {
      name: settings.name,
      displayName: settings.displayName,
      timezone: settings.timezone,
      currency: settings.currency,
      contact: settings.contact,
      terminology: settings.terminology,
    },
  });

  async function onSubmit(values: Values) {
    setMsg(null);
    const body: Record<string, unknown> = { displayName: values.displayName, contact: values.contact, terminology: values.terminology };
    if (canEditProtected) Object.assign(body, { name: values.name, timezone: values.timezone, currency: values.currency.toUpperCase() });
    const res = await apiRequest<OrganizationSettings>("/api/v1/organization", { method: "PATCH", body });
    if (res.ok) {
      setMsg({ tone: "success", title: "Organization settings saved" });
      reset({ ...res.data });
      router.refresh();
    } else {
      const first = res.fieldErrors ? Object.entries(res.fieldErrors)[0] : undefined;
      setMsg({ tone: "danger", title: "Settings not saved", body: first ? `${first[0]}: ${first[1][0]}` : res.message });
    }
  }

  const disabled = !canEdit;

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
      {msg ? (
        <Alert tone={msg.tone} title={msg.title}>
          {msg.body}
        </Alert>
      ) : null}
      {!canEdit ? <Alert tone="info" title="Read-only">You can view these settings but not change them.</Alert> : null}

      <Card>
        <CardHeader
          title="Identity and regional settings"
          description={canEditProtected ? "Legal name, timezone and currency affect records and reports." : "Legal name, timezone and currency can only be changed by a superadmin."}
        />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Display name" required error={errors.displayName?.message}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} disabled={disabled} aria-describedby={describedBy} invalid={invalid} {...register("displayName", { required: "Display name is required." })} />
            )}
          </Field>
          <Field label="Legal business name" hint={!canEditProtected ? "Superadmin only" : undefined}>
            {({ id, describedBy }) => <Input id={id} disabled={!canEditProtected} aria-describedby={describedBy} {...register("name", { required: true })} />}
          </Field>
          <Field label="Timezone" hint={canEditProtected ? "IANA name, e.g. America/Toronto" : "Superadmin only"}>
            {({ id, describedBy }) => <Input id={id} disabled={!canEditProtected} aria-describedby={describedBy} {...register("timezone", { required: true })} />}
          </Field>
          <Field label="Currency" hint={canEditProtected ? "3-letter ISO code, e.g. CAD" : "Superadmin only"}>
            {({ id, describedBy }) => <Input id={id} maxLength={3} disabled={!canEditProtected} aria-describedby={describedBy} {...register("currency", { required: true })} />}
          </Field>
        </div>
        {!canEditProtected ? (
          <p className="flex items-center gap-1 border-t border-line px-5 py-3 text-xs text-muted">
            <Lock className="size-3.5" aria-hidden /> Protected owner settings
          </p>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="Business contact details" description="Shown to your team; used later on customer-facing documents." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {CONTACT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              {({ id, describedBy }) => (
                <Input id={id} type={f.type ?? "text"} autoComplete={f.autoComplete} disabled={disabled} aria-describedby={describedBy} {...register(`contact.${f.key}`)} />
              )}
            </Field>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader title="Terminology" description="Singular labels used in navigation and pages, so the CRM fits your kind of service business." />
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          <Field label="Customer label">{({ id }) => <Input id={id} disabled={disabled} {...register("terminology.customer", { required: true })} />}</Field>
          <Field label="Booking label">{({ id }) => <Input id={id} disabled={disabled} {...register("terminology.booking", { required: true })} />}</Field>
          <Field label="Service provider label">{({ id }) => <Input id={id} disabled={disabled} {...register("terminology.provider", { required: true })} />}</Field>
        </div>
      </Card>

      {canEdit ? (
        <div className="flex justify-end">
          <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
            Save settings
          </Button>
        </div>
      ) : null}
    </form>
  );
}
