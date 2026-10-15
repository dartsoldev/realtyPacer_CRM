"use client";

import { AttachmentsPanel } from "./attachments-panel";
import { Archive, Pencil, Plus, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/client/api";
import { formatAddress } from "@/lib/domain/links";
import type { AddressDTO } from "@/modules/customers/addresses";
import { AddressFields, addressErrors, addressPayload, EMPTY_ADDRESS, type AddressFormValue } from "./address-fields";
import { ExternalAnchor, MapLink } from "./contact";

function toForm(a: AddressDTO): AddressFormValue {
  return {
    label: a.label,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    region: a.region,
    postalCode: a.postalCode,
    country: a.country,
    lat: a.location ? String(a.location.lat) : "",
    lng: a.location ? String(a.location.lng) : "",
    accessInstructions: a.accessInstructions,
    isPrimary: a.isPrimary,
    links: a.links,
  };
}

/** Address dialog used by the profile and by the booking form ("new address"). */
export function AddressDialog({
  customerId,
  open,
  onClose,
  editing,
  onSaved,
  isFirst,
}: {
  customerId: string;
  open: boolean;
  onClose: () => void;
  editing?: AddressDTO | null;
  onSaved: (a: AddressDTO) => void;
  isFirst?: boolean;
}) {
  const [value, setValue] = useState<AddressFormValue>(editing ? toForm(editing) : { ...EMPTY_ADDRESS, isPrimary: Boolean(isFirst) });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setFailure(null);
    const res = editing
      ? await apiRequest<AddressDTO>(`/api/v1/customers/${customerId}/addresses/${editing.id}`, { method: "PATCH", body: addressPayload(value) })
      : await apiRequest<AddressDTO>(`/api/v1/customers/${customerId}/addresses`, { method: "POST", body: addressPayload(value) });
    setSaving(false);
    if (res.ok) {
      onSaved(res.data);
      onClose();
      return;
    }
    setErrors(addressErrors(res.fieldErrors));
    setFailure(res.fieldErrors ? "Please correct the highlighted fields." : res.message);
  }

  return (
    <Modal title={editing ? "Edit service address" : "Add service address"} open={open} onClose={onClose} wide>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="space-y-4"
      >
        {failure ? <Alert tone="danger" title="Address not saved">{failure}</Alert> : null}
        {editing ? <Alert tone="info" title="Past bookings are not changed">Existing bookings keep the address they were booked with. Future bookings can be moved to the updated address from the booking page.</Alert> : null}
        <AddressFields value={value} onChange={setValue} errors={errors} idPrefix={editing ? `edit-${editing.id}` : "new"} />
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Save address
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function AddressManager({ customerId, addresses, canWrite, files }: { customerId: string; addresses: AddressDTO[]; canWrite: boolean; files?: { canRead: boolean; canUpload: boolean; configured: boolean } }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<{ editing: AddressDTO | null } | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function archive(a: AddressDTO) {
    if (!window.confirm(`Archive “${a.label || a.line1}”? Existing bookings keep their saved address.`)) return;
    setBusy(a.id);
    const res = await apiRequest(`/api/v1/customers/${customerId}/addresses/${a.id}`, { method: "DELETE" });
    setBusy(null);
    setMessage(res.ok ? { tone: "success", text: "Address archived." } : { tone: "danger", text: res.message });
    router.refresh();
  }

  async function makeDefault(a: AddressDTO) {
    setBusy(a.id);
    const res = await apiRequest(`/api/v1/customers/${customerId}/addresses/${a.id}`, { method: "PATCH", body: addressPayload({ ...toForm(a), isPrimary: true }) });
    setBusy(null);
    if (!res.ok) setMessage({ tone: "danger", text: res.message });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {message ? <Alert tone={message.tone} title={message.text} /> : null}
      {canWrite ? (
        <Button onClick={() => setDialog({ editing: null })}>
          <Plus className="size-4" aria-hidden /> Add address
        </Button>
      ) : null}
      {addresses.length === 0 ? <p className="text-sm text-muted">No service addresses yet.</p> : null}
      <ul className="grid gap-3 md:grid-cols-2">
        {addresses.map((a) => (
          <li key={a.id} className="space-y-2 rounded-xl border border-line p-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">{a.label || "Address"}</p>
              {a.isPrimary ? <Badge tone="info" icon={Star}>Default</Badge> : null}
            </div>
            <p>{formatAddress(a)}</p>
            {a.accessInstructions ? (
              <p className="rounded-md bg-canvas p-2 text-muted">
                <span className="font-medium text-ink">Access: </span>
                {a.accessInstructions}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <MapLink href={a.mapUrl} />
              {a.links.map((l) => (
                <ExternalAnchor key={l.url} href={l.url}>
                  {l.label}
                </ExternalAnchor>
              ))}
            </div>
            {files?.canRead ? (
              <details className="rounded-md border border-line p-2">
                <summary className="cursor-pointer text-sm font-medium">Photos and documents</summary>
                <div className="pt-2">
                  <AttachmentsPanel parentType="address" parentId={a.id} categories={["property_photo", "document"]} canUpload={files.canUpload} configured={files.configured} />
                </div>
              </details>
            ) : null}
            {canWrite ? (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="secondary" onClick={() => setDialog({ editing: a })}>
                  <Pencil className="size-4" aria-hidden /> Edit
                </Button>
                {!a.isPrimary ? (
                  <Button size="sm" variant="ghost" loading={busy === a.id} onClick={() => void makeDefault(a)}>
                    Make default
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" loading={busy === a.id} onClick={() => void archive(a)}>
                  <Archive className="size-4" aria-hidden /> Archive
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {dialog ? (
        <AddressDialog
          key={dialog.editing?.id ?? "new"}
          customerId={customerId}
          open
          editing={dialog.editing}
          isFirst={addresses.length === 0}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setMessage({ tone: "success", text: "Address saved." });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}
