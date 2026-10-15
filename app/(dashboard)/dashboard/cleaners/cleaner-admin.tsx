"use client";

import Link from "next/link";
import { Link2, Mail, Pencil, Plus, Unlink } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { CustomFieldInputs, changedCustomFields, useCustomFieldDefs, type CustomFieldDraft } from "@/components/custom-fields/inputs";
import { formatDateTime } from "@/lib/domain/time";
import type { AffectedBooking, CleanerDTO } from "@/modules/cleaners/service";

type FormState = { name: string; phone: string; email: string; serviceAreas: string; notes: string };

function CleanerDialog({ cleaner, onClose }: { cleaner: CleanerDTO | null; onClose: () => void }) {
  const router = useRouter();
  const [v, setV] = useState<FormState>({
    name: cleaner?.name ?? "",
    phone: cleaner?.phoneDisplay ?? "",
    email: cleaner?.email ?? "",
    serviceAreas: cleaner?.serviceAreas.join(", ") ?? "",
    notes: cleaner?.notes ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const cfDefs = useCustomFieldDefs("cleaner");
  const [cf, setCf] = useState<CustomFieldDraft>(cleaner?.customFields ?? {});

  async function save() {
    if (!v.name.trim()) {
      setErrors({ name: "Name is required" });
      return;
    }
    setSaving(true);
    setFailure(null);
    const body = { name: v.name, phone: v.phone, email: v.email, serviceAreas: v.serviceAreas.split(",").map((s) => s.trim()).filter(Boolean), notes: v.notes, customFields: changedCustomFields(cfDefs, cleaner?.customFields ?? {}, cf) };
    const res = cleaner ? await apiRequest<CleanerDTO>(`/api/v1/cleaners/${cleaner.id}`, { method: "PATCH", body }) : await apiRequest<CleanerDTO>("/api/v1/cleaners", { method: "POST", body });
    setSaving(false);
    if (!res.ok) {
      setErrors(Object.fromEntries(Object.entries(res.fieldErrors ?? {}).map(([k, m]) => [k, m[0]!])));
      setFailure(res.message);
      return;
    }
    if (!cleaner) router.push(`/dashboard/cleaners/${res.data.id}`);
    router.refresh();
    onClose();
  }
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });

  return (
    <Modal title={cleaner ? `Edit ${cleaner.name}` : "New cleaner"} open onClose={onClose}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {failure ? <Alert tone="danger" title="Cleaner not saved">{failure}</Alert> : null}
        {!cleaner ? <Alert tone="info" title="No sign-in access is created">You can invite this person to sign in later from their profile.</Alert> : null}
        <Field label="Display name" required error={errors.name}>
          {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} invalid={invalid} value={v.name} onChange={set("name")} maxLength={120} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone" hint="Canada by default; start with + for other countries" error={errors.phone}>
            {({ id, describedBy, invalid }) => <Input id={id} type="tel" aria-describedby={describedBy} invalid={invalid} value={v.phone} onChange={set("phone")} maxLength={40} />}
          </Field>
          <Field label="Email (optional)" error={errors.email}>
            {({ id, describedBy, invalid }) => <Input id={id} type="email" aria-describedby={describedBy} invalid={invalid} value={v.email} onChange={set("email")} maxLength={254} />}
          </Field>
        </div>
        <Field label="Service areas" hint="Comma-separated, e.g. Montreal, Laval">
          {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={v.serviceAreas} onChange={set("serviceAreas")} />}
        </Field>
        <Field label="Internal notes">
          {({ id }) => <textarea id={id} rows={3} maxLength={5000} value={v.notes} onChange={set("notes")} className="block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base sm:text-sm" />}
        </Field>
        <CustomFieldInputs defs={cfDefs} values={cf} errors={errors} onChange={(k, val) => setCf((prev) => ({ ...prev, [k]: val }))} />
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Save cleaner
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function NewCleanerButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden /> New cleaner
      </Button>
      {open ? <CleanerDialog cleaner={null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function EditCleanerButton({ cleaner }: { cleaner: CleanerDTO }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Pencil className="size-4" aria-hidden /> Edit
      </Button>
      {open ? <CleanerDialog cleaner={cleaner} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Activate/deactivate/archive. After deactivating, lists the future jobs that still need reassignment. */
export function CleanerStateActions({ cleaner, timezone }: { cleaner: CleanerDTO; timezone: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [affected, setAffected] = useState<AffectedBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setState(state: "active" | "inactive" | "archived") {
    if (state !== "active" && !window.confirm(state === "archived" ? "Archive this cleaner? They can't be assigned to new jobs." : "Deactivate this cleaner? They can't be assigned to new jobs; existing assignments are kept for you to reassign.")) return;
    setBusy(state);
    setError(null);
    const res = await apiRequest<{ affectedBookings: AffectedBooking[] }>(`/api/v1/cleaners/${cleaner.id}/state`, { method: "POST", body: { state } });
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setAffected(res.data.affectedBookings);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {cleaner.active ? (
          <Button variant="danger" size="sm" loading={busy === "inactive"} onClick={() => void setState("inactive")}>
            Deactivate
          </Button>
        ) : (
          <Button variant="secondary" size="sm" loading={busy === "active"} onClick={() => void setState("active")}>
            Reactivate
          </Button>
        )}
        {!cleaner.archived ? (
          <Button variant="ghost" size="sm" loading={busy === "archived"} onClick={() => void setState("archived")}>
            Archive
          </Button>
        ) : null}
      </div>
      {error ? <Alert tone="danger" title="Not changed">{error}</Alert> : null}
      {affected && affected.length > 0 ? (
        <Alert tone="pending" title={`${affected.length} upcoming job${affected.length === 1 ? "" : "s"} still assigned`}>
          <p>These assignments were kept. Open each booking to reassign it:</p>
          <ul className="mt-2 list-disc pl-5">
            {affected.map((b) => (
              <li key={b.id}>
                <Link href={`/dashboard/bookings/${b.id}`} className="font-medium underline">
                  {formatDateTime(b.scheduledStartAt, timezone)} — {b.customerName}
                </Link>{" "}
                <span className="text-muted">({b.reference})</span>
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {affected && affected.length === 0 ? <Alert tone="success" title="No upcoming jobs are affected" /> : null}
    </div>
  );
}

/** Sign-in account: explicit invite (existing invitation flow) or link an existing CLEANER user. */
export function CleanerAccount({ cleaner, canInvite, canLink }: { cleaner: CleanerDTO; canInvite: boolean; canLink: boolean }) {
  const router = useRouter();
  const [users, setUsers] = useState<{ id: string; name: string; email: string; status: string }[] | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger" | "pending"; text: string } | null>(null);

  useEffect(() => {
    if (!canLink || cleaner.linkedUser) return;
    void apiRequest<{ items: { id: string; name: string; email: string; status: string }[] }>("/api/v1/cleaners/linkable-users").then((r) => setUsers(r.ok ? r.data.items : []));
  }, [canLink, cleaner.linkedUser]);

  async function call(key: string, path: string, body?: unknown, ok = "Saved") {
    setBusy(key);
    setMsg(null);
    const res = await apiRequest(path, { method: "POST", body });
    setBusy(null);
    if (res.ok) setMsg({ tone: "success", text: ok });
    else if (res.code === "EMAIL_DELIVERY_FAILED") setMsg({ tone: "pending", text: "The account was created and linked, but the invitation email was not sent. Resend it from Users once email works." });
    else setMsg({ tone: "danger", text: res.message });
    router.refresh();
  }

  if (cleaner.linkedUser) {
    return (
      <div className="space-y-2 text-sm">
        <p>
          Linked to <span className="font-medium">{cleaner.linkedUser.name}</span> ({cleaner.linkedUser.email}) — account {cleaner.linkedUser.status}.
        </p>
        {canLink ? (
          <Button size="sm" variant="ghost" loading={busy === "unlink"} onClick={() => void call("unlink", `/api/v1/cleaners/${cleaner.id}/link-user`, { userId: null }, "Account unlinked")}>
            <Unlink className="size-4" aria-hidden /> Unlink account
          </Button>
        ) : null}
        {msg ? <Alert tone={msg.tone} title={msg.text} /> : null}
      </div>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">This cleaner can’t sign in. Creating a cleaner never grants access automatically.</p>
      {canInvite ? (
        <div className="space-y-1">
          <Button size="sm" loading={busy === "invite"} disabled={!cleaner.email} onClick={() => void call("invite", `/api/v1/cleaners/${cleaner.id}/invite`, undefined, "Invitation sent and account linked")}>
            <Mail className="size-4" aria-hidden /> Invite to sign in
          </Button>
          {!cleaner.email ? <p className="text-xs text-muted">Add an email address first.</p> : null}
        </div>
      ) : null}
      {canLink && users && users.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Or link an existing cleaner account</span>
            <Select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Choose…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
          </label>
          <Button size="sm" variant="secondary" disabled={!selected} loading={busy === "link"} onClick={() => void call("link", `/api/v1/cleaners/${cleaner.id}/link-user`, { userId: selected }, "Account linked")}>
            <Link2 className="size-4" aria-hidden /> Link
          </Button>
        </div>
      ) : null}
      {msg ? <Alert tone={msg.tone} title={msg.text} /> : null}
    </div>
  );
}
