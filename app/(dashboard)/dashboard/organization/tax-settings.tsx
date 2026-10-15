"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Card, CardHeader } from "@/components/ui/layout";
import { apiRequest } from "@/lib/client/api";
import { formatBasisPoints, percentToBasisPoints } from "@/lib/domain/billing";

/**
 * One sales-tax rate applied when charges are finalized. Off by default.
 * Each finalized booking keeps a snapshot, so changing this never alters past charges.
 */
export function TaxSettings({ tax, canEdit }: { tax: { enabled: boolean; rateBasisPoints: number; label: string }; canEdit: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(tax.enabled);
  const [label, setLabel] = useState(tax.label);
  const [rate, setRate] = useState(tax.enabled ? String(tax.rateBasisPoints / 100) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function save() {
    const bp = enabled ? percentToBasisPoints(rate) : 0;
    if (enabled && (bp === null || bp === 0)) return setMsg({ tone: "danger", text: "Enter a rate above 0, e.g. 13 or 14.975." });
    setBusy(true);
    setMsg(null);
    const res = await apiRequest("/api/v1/organization", { method: "PATCH", body: { tax: { enabled, rateBasisPoints: bp ?? 0, label: enabled ? label : "" } } });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "danger", text: res.fieldErrors ? (Object.values(res.fieldErrors)[0]?.[0] ?? res.message) : res.message });
    setMsg({ tone: "success", text: "Saved. Applies to bookings finalized from now on." });
    router.refresh();
  }

  return (
    <Card className="mt-6">
      <CardHeader
        title="Sales tax"
        description={canEdit ? "Optional. Added when charges are finalized; earlier charges keep the rate they were finalized with." : "Only a superadmin can change tax settings."}
      />
      <form className="space-y-4 px-5 py-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <p className="text-sm text-muted">
          Currently: {tax.enabled ? `${tax.label} at ${formatBasisPoints(tax.rateBasisPoints)}` : "no tax is added"}. RealtyPacer applies one rate you enter; it doesn’t determine which taxes apply to your business or produce tax filings.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-brand" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} /> Add tax to finalized charges
        </label>
        {enabled ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tax name" required hint="Shown on charges, e.g. HST">
              {(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} disabled={!canEdit} />}
            </Field>
            <Field label="Rate (%)" required hint="Up to two decimals">
              {(p) => <Input {...p} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} disabled={!canEdit} />}
            </Field>
          </div>
        ) : null}
        {msg ? <Alert tone={msg.tone} title={msg.tone === "success" ? "Tax settings saved" : "Not saved"}>{msg.text}</Alert> : null}
        {canEdit ? (
          <div className="flex justify-end">
            <Button type="submit" loading={busy}>Save tax settings</Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}
