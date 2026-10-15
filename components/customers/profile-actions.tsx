"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CustomFieldInputs, changedCustomFields, type CustomFieldDraft } from "@/components/custom-fields/inputs";
import { AddressDialog } from "@/components/ops/address-manager";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/client/api";
import type { CustomFieldDef } from "@/modules/custom-fields/service";
import type { AddressDTO } from "@/modules/customers/addresses";

/** Edits the current address in place. Past bookings keep the address they were done at. */
export function EditAddressButton({ customerId, address }: { customerId: string; address: AddressDTO | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-sm font-medium text-brand hover:bg-canvas">
        <Pencil className="size-4" aria-hidden /> {address ? "Edit address" : "Add address"}
      </button>
      {open ? (
        <AddressDialog
          customerId={customerId}
          open
          editing={address}
          isFirst={!address}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/** Custom field values edited directly on the profile. */
export function CustomFieldsEditor({ customerId, defs, values }: { customerId: string; defs: CustomFieldDef[]; values: Record<string, unknown> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CustomFieldDraft>(values);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    const changes = changedCustomFields(defs, values, draft);
    if (!changes) return setOpen(false);
    setBusy(true);
    setError(null);
    const res = await apiRequest(`/api/v1/customers/${customerId}/custom-fields`, { method: "PATCH", body: { customFields: changes } });
    setBusy(false);
    if (!res.ok) {
      setErrors(Object.fromEntries(Object.entries(res.fieldErrors ?? {}).map(([k, m]) => [k, m[0]!])));
      return setError(res.message);
    }
    setOpen(false);
    router.refresh();
  }
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => { setDraft(values); setErrors({}); setError(null); setOpen(true); }}>
        <Pencil className="size-4" aria-hidden /> Edit
      </Button>
      <Modal title="Edit details" open={open} onClose={() => setOpen(false)} wide>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <CustomFieldInputs defs={defs} values={draft} errors={errors} onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))} />
          {error ? <Alert tone="danger" title="Not saved">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>Save</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
