"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Card, CardHeader } from "@/components/ui/layout";
import { apiRequest } from "@/lib/client/api";

type Mode = "off" | "manual" | "auto";

/** Customer booking emails: off by default; staff send manually, or automatically on changes. */
export function NotificationSettings({ value, canEdit, emailConfigured }: { value: Mode; canEdit: boolean; emailConfigured: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(value);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  async function save() {
    setBusy(true);
    setMsg(null);
    const res = await apiRequest("/api/v1/organization", { method: "PATCH", body: { notifications: { customerBookingEmails: mode } } });
    setBusy(false);
    if (!res.ok) return setMsg({ tone: "danger", text: res.message });
    setMsg({ tone: "success", text: "Saved." });
    router.refresh();
  }
  return (
    <Card className="mt-6">
      <CardHeader title="Customer booking emails" description="Confirmation, change and cancellation emails to customers who have an email address. Schedule details only — no prices or office notes." />
      <form className="space-y-4 px-5 py-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {!emailConfigured ? <Alert tone="pending" title="Email isn’t configured on the server">Set the SMTP variables and run the background worker before turning this on.</Alert> : null}
        <Field label="Sending" hint="Automatic emails go out when a booking is created, rescheduled, moved to another address or cancelled. The background worker must be running.">
          {(p) => (
            <Select {...p} value={mode} disabled={!canEdit} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="off">Off (default)</option>
              <option value="manual">Manual — staff preview and send from a booking</option>
              <option value="auto">Automatic — also send on booking changes</option>
            </Select>
          )}
        </Field>
        {msg ? <Alert tone={msg.tone} title={msg.tone === "success" ? "Saved" : "Not saved"}>{msg.text}</Alert> : null}
        {canEdit ? <div className="flex justify-end"><Button type="submit" loading={busy}>Save</Button></div> : null}
      </form>
    </Card>
  );
}
