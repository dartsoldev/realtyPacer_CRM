"use client";

import { Ban, Mail, RotateCcw, Settings2, UserPlus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest, type ApiFailure } from "@/lib/client/api";
import { ROLE_LABELS, type Role } from "@/lib/domain/constants";
import type { Permission } from "@/lib/permissions/matrix";
import type { UserListItem } from "@/modules/users/service";

const GRANT_LABELS: Partial<Record<Permission, string>> = {
  "customers:write": "Create and edit customers",
  "services:write": "Manage the service catalog",
  "bookings:write": "Create, edit, reschedule and cancel bookings",
  "pricing:read": "See prices and booking amounts",
  "bookings:price_override": "Change booking prices (needs “See prices”)",
  "cleaners:read": "View cleaners",
  "cleaners:write": "Manage cleaners",
  "financials:read": "View payments, balances and credit",
  "payments:record": "Record payments",
  "payments:allocate": "Apply customer credit",
  "payments:refund": "Record refunds and reverse receipts",
  "billing:finalize": "Finalize charges and set discounts",
  "billing:adjust": "Credit or adjust finalized charges",
  "reports:read": "View reports",
  "reports:export": "Export reports (CSV)",
  "views:share": "Share saved views with everyone",
  "loyalty:read": "View loyalty points",
  "loyalty:adjust": "Grant, redeem and correct points",
};

function Modal({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // Native <dialog>: focus trap, Escape to close, focus restored on close.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby={titleId}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-0 text-left shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <button type="button" onClick={onClose} className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-canvas" aria-label="Close dialog">
          <X className="size-5" aria-hidden />
        </button>
      </div>
      <div className="max-h-[75dvh] overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}

function GrantCheckboxes({ grantable, value, onChange }: { grantable: Permission[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Extra permissions for this staff member</legend>
      <p className="text-xs text-muted">Staff can always view customers, services, bookings and the calendar.</p>
      {grantable.map((p) => (
        <label key={p} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-brand"
            checked={value.includes(p)}
            onChange={(e) => onChange(e.target.checked ? [...value, p] : value.filter((x) => x !== p))}
          />
          {GRANT_LABELS[p] ?? p}
        </label>
      ))}
    </fieldset>
  );
}

type InviteValues = { name: string; email: string; role: Role };

export function InviteUserButton({ roles, grantable }: { roles: Role[]; grantable: Permission[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [grants, setGrants] = useState<string[]>([]);
  const [result, setResult] = useState<{ tone: "success" | "danger" | "pending"; title: string; body?: string } | null>(null);
  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<InviteValues>({ defaultValues: { name: "", email: "", role: roles.includes("STAFF") ? "STAFF" : roles[0] } });
  const role = useWatch({ control, name: "role" });

  function close() {
    setOpen(false);
    setResult(null);
  }

  async function onSubmit(values: InviteValues) {
    setResult(null);
    const res = await apiRequest<{ id: string }>("/api/v1/users", {
      method: "POST",
      body: { ...values, ...(values.role === "STAFF" ? { permissionGrants: grants } : {}) },
    });
    if (res.ok) {
      setResult({ tone: "success", title: "Invitation sent", body: `The SMTP server accepted the invitation email for ${values.email}.` });
      reset();
      setGrants([]);
      router.refresh();
      return;
    }
    handleFailure(res, values.email);
  }

  function handleFailure(res: ApiFailure, email: string) {
    if (res.fieldErrors?.email?.[0]) return setError("email", { message: res.fieldErrors.email[0] });
    if (res.fieldErrors?.name?.[0]) return setError("name", { message: res.fieldErrors.name[0] });
    if (res.code === "EMAIL_DELIVERY_FAILED") {
      router.refresh();
      return setResult({
        tone: "pending",
        title: "User created, but the email was not sent",
        body: `The invitation for ${email} could not be delivered to the mail server. Nothing was sent. Use “Resend invitation” from the user list once email is working.`,
      });
    }
    if (res.code === "SETUP_REQUIRED") return setResult({ tone: "danger", title: "Email is not configured", body: "No user was created. Configure SMTP first." });
    setResult({ tone: "danger", title: "Invitation not created", body: res.message });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <UserPlus className="size-4" aria-hidden />
        Invite user
      </Button>
      <Modal title="Invite a user" open={open} onClose={close}>
        <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
          {result ? (
            <Alert tone={result.tone} title={result.title}>
              {result.body}
            </Alert>
          ) : null}
          <Field label="Full name" required error={errors.name?.message}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} aria-describedby={describedBy} invalid={invalid} {...register("name", { required: "Name is required.", maxLength: { value: 120, message: "Too long." } })} />
            )}
          </Field>
          <Field label="Email" required error={errors.email?.message}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="email" aria-describedby={describedBy} invalid={invalid} {...register("email", { required: "Email is required." })} />
            )}
          </Field>
          <Field label="Role" required hint="Customer and cleaner records never create sign-in accounts automatically.">
            {({ id, describedBy }) => (
              <Select id={id} aria-describedby={describedBy} {...register("role")}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {role === "STAFF" ? <GrantCheckboxes grantable={grantable} value={grants} onChange={setGrants} /> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={close}>
              Close
            </Button>
            <Button type="submit" loading={isSubmitting}>
              <Mail className="size-4" aria-hidden />
              Send invitation
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export function UserActions({ user, roles, grantable, canInvite }: { user: UserListItem; roles: Role[]; grantable: Permission[]; canInvite: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<Role>(user.role);
  const [grants, setGrants] = useState<string[]>(user.permissionGrants);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger" | "pending"; title: string; body?: string } | null>(null);

  const roleOptions = roles.includes(user.role) ? roles : [user.role, ...roles];
  const grantsChanged = role === "STAFF" && JSON.stringify([...grants].sort()) !== JSON.stringify([...user.permissionGrants].sort());

  async function run(key: string, fn: () => ReturnType<typeof apiRequest>, success: string) {
    setBusy(key);
    setMsg(null);
    const res = await fn();
    setBusy(null);
    if (res.ok) {
      setMsg({ tone: "success", title: success });
      router.refresh();
    } else if (res.code === "EMAIL_DELIVERY_FAILED") {
      setMsg({ tone: "pending", title: "Email not sent", body: "The mail server did not accept the invitation. Nothing was delivered; try again later." });
      router.refresh();
    } else {
      setMsg({ tone: "danger", title: "Change not saved", body: res.message });
    }
  }

  const patch = (body: Record<string, unknown>) => () => apiRequest(`/api/v1/users/${user.id}`, { method: "PATCH", body });

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} aria-label={`Manage ${user.name}`}>
        <Settings2 className="size-4" aria-hidden />
        Manage
      </Button>
      <Modal title={`Manage ${user.name}`} open={open} onClose={() => { setOpen(false); setMsg(null); }}>
        <div className="space-y-5">
          {msg ? (
            <Alert tone={msg.tone} title={msg.title}>
              {msg.body}
            </Alert>
          ) : null}
          <p className="break-all text-sm text-muted">{user.email}</p>

          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium">Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-base sm:text-sm">
                {roleOptions.map((r) => (
                  <option key={r} value={r} disabled={!roles.includes(r)}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            {role === "STAFF" ? <GrantCheckboxes grantable={grantable} value={grants} onChange={setGrants} /> : null}
            <Button
              size="sm"
              disabled={role === user.role && !grantsChanged}
              loading={busy === "role"}
              onClick={() =>
                run("role", patch({ ...(role !== user.role ? { role } : {}), ...(role === "STAFF" ? { permissionGrants: grants } : {}) }), "Access updated")
              }
            >
              Save access
            </Button>
          </div>

          <div className="space-y-2 border-t border-line pt-4">
            <p className="text-sm font-medium">Account access</p>
            {user.status === "suspended" ? (
              <Button variant="secondary" size="sm" loading={busy === "status"} onClick={() => run("status", patch({ status: "active" }), "User reactivated")}>
                <RotateCcw className="size-4" aria-hidden />
                Reactivate
              </Button>
            ) : (
              <Button variant="danger" size="sm" loading={busy === "status"} onClick={() => run("status", patch({ status: "suspended" }), "User suspended — their sessions are revoked")}>
                <Ban className="size-4" aria-hidden />
                Suspend user
              </Button>
            )}
            <p className="text-xs text-muted">Suspending signs the user out immediately and blocks sign-in until reactivated.</p>
          </div>

          {user.status === "invited" && canInvite ? (
            <div className="space-y-2 border-t border-line pt-4">
              <p className="text-sm font-medium">Invitation</p>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === "invite"}
                onClick={() => run("invite", () => apiRequest(`/api/v1/users/${user.id}/resend-invitation`, { method: "POST" }), "New invitation email accepted by the mail server")}
              >
                <Mail className="size-4" aria-hidden />
                Resend invitation
              </Button>
              <p className="text-xs text-muted">Sending a new invitation invalidates the previous link.</p>
            </div>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
