"use client";

import { ArrowRight, CalendarCheck2, RefreshCw, Unplug } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";

export type GoogleStatusView = {
  configured: boolean;
  configIssue: string | null;
  redirectUri: string;
  connection: { status: string; googleEmail: string | null; calendarId: string | null; calendarName: string | null; lastSyncAt: string | null; lastError: string | null; lastErrorAt: string | null; lastVerifiedAt: string | null } | null;
  counts: Record<string, number>;
  problems: { id: string; bookingId: string; reference: string; status: string; externalState: string | null; lastError: string | null; attempts: number; updatedAt: string }[];
};

const fmtIn = (timeZone: string) => (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-CA", { timeZone, dateStyle: "medium", timeStyle: "short" }) : "Never");

export function GoogleCalendarCard({ status, flash, timeZone }: { status: GoogleStatusView; flash: { ok?: boolean; error?: string }; timeZone: string }) {
  const fmt = fmtIn(timeZone);
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<{ id: string; name: string; primary: boolean }[] | null>(null);
  const [selected, setSelected] = useState(status.connection?.calendarId ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const conn = status.connection;

  async function call<T>(which: string, path: string, method = "POST", body?: unknown) {
    setBusy(which);
    setError(null);
    setNotice(null);
    const res = await apiRequest<T>(path, { method, body });
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return null;
    }
    return res.data;
  }

  async function connect() {
    const data = await call<{ url: string }>("connect", "/api/v1/integrations/google/connect");
    if (data) window.location.assign(data.url);
  }
  async function loadCalendars() {
    const data = await call<{ items: { id: string; name: string; primary: boolean }[] }>("calendars", "/api/v1/integrations/google/calendars", "GET");
    if (data) {
      setCalendars(data.items);
      if (!selected) setSelected(data.items.find((c) => c.primary)?.id ?? data.items[0]?.id ?? "");
    }
  }
  async function saveCalendar() {
    if (await call("save", "/api/v1/integrations/google/calendar", "POST", { calendarId: selected })) {
      setNotice("Calendar saved. Upcoming bookings will be added by the background worker.");
      router.refresh();
    }
  }
  async function retry() {
    const data = await call<{ queued: number }>("retry", "/api/v1/integrations/google/retry", "POST", {});
    if (data) {
      setNotice(`${data.queued} booking${data.queued === 1 ? "" : "s"} queued for another attempt.`);
      router.refresh();
    }
  }
  async function disconnect() {
    if (!window.confirm("Disconnect Google Calendar? Access is revoked and stored tokens are deleted. Events already in Google stay there.")) return;
    if (await call("disconnect", "/api/v1/integrations/google/disconnect")) router.refresh();
  }

  const state = !status.configured ? "not_configured" : !conn ? "not_connected" : conn.status === "needs_reauth" ? "needs_reauth" : !conn.calendarId ? "choose_calendar" : "connected";

  return (
    <div className="space-y-4 p-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {state === "connected" ? <Badge tone="success">Connected</Badge> : state === "needs_reauth" ? <Badge tone="danger">Reconnect needed</Badge> : state === "choose_calendar" ? <Badge tone="pending">Choose a calendar</Badge> : <Badge tone="slate">Not connected</Badge>}
        <Badge tone="info">Outbound only: RealtyPacer → Google</Badge>
      </div>
      <p className="text-muted">
        RealtyPacer is the source of truth. Booking changes create, update or remove events in one Google calendar. Events created in Google are never imported as customers, jobs or leads, and customers are never invited or emailed.
      </p>
      {flash.ok ? <Alert tone="success" title="Google account connected">Choose the calendar to use below.</Alert> : null}
      {flash.error ? <Alert tone="danger" title="Google connection not completed">{flash.error === "denied" ? "Access was not granted in Google." : flash.error === "signin" ? "Sign in as an owner/admin and try again." : `Google returned an error (${flash.error}). Try again.`}</Alert> : null}

      {state === "not_configured" ? (
        <Alert tone="info" title="Not connected — server setup needed">
          {status.configIssue ? <p className="mb-2 text-danger">{status.configIssue}</p> : null}
          <ol className="list-decimal space-y-1 pl-5">
            <li>In Google Cloud Console create (or choose) a project and enable the <strong>Google Calendar API</strong>.</li>
            <li>Configure the OAuth consent screen (External or Internal) and add the scopes <code>calendar.events</code> and <code>calendar.calendarlist.readonly</code>.</li>
            <li>Create an OAuth client ID of type <strong>Web application</strong> with this authorized redirect URI: <code className="break-all">{status.redirectUri}</code></li>
            <li>Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and <code>TOKEN_ENCRYPTION_KEY</code> (32 random bytes, base64) in the server environment, then restart the app and worker.</li>
          </ol>
          <p className="mt-2">Never paste these values into chat or browser code. See <code>docs/GOOGLE_CALENDAR.md</code>.</p>
        </Alert>
      ) : null}

      {state === "not_connected" || state === "needs_reauth" ? (
        <div className="space-y-2">
          {state === "needs_reauth" ? <Alert tone="danger" title="Google access was revoked or expired">{conn?.lastError ?? "Reconnect to resume syncing."} Pending changes are kept and sent after you reconnect.</Alert> : null}
          <Button onClick={() => void connect()} loading={busy === "connect"}>
            <CalendarCheck2 className="size-4" aria-hidden /> {state === "needs_reauth" ? "Reconnect Google Calendar" : "Connect Google Calendar"}
          </Button>
        </div>
      ) : null}

      {conn && state !== "needs_reauth" ? (
        <div className="space-y-4">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <div><dt className="text-muted">Google account</dt><dd>{conn.googleEmail || "—"}</dd></div>
            <div><dt className="text-muted">Calendar</dt><dd>{conn.calendarName ?? "Not chosen"}</dd></div>
            <div><dt className="text-muted">Last successful sync</dt><dd>{fmt(conn.lastSyncAt)}</dd></div>
            <div><dt className="text-muted">Last check for changes in Google</dt><dd>{fmt(conn.lastVerifiedAt)} <span className="text-muted">(hourly)</span></dd></div>
            <div><dt className="text-muted">Events in sync</dt><dd>{status.counts.synced ?? 0} · waiting {(status.counts.pending ?? 0) + (status.counts.processing ?? 0)} · failed {status.counts.failed ?? 0}</dd></div>
            {conn.lastError ? <div><dt className="text-muted">Last error</dt><dd className="text-danger">{conn.lastError} <span className="text-muted">({fmt(conn.lastErrorAt)})</span></dd></div> : null}
          </dl>
          <div className="flex flex-wrap items-end gap-2">
            {calendars ? (
              <>
                <div className="min-w-[16rem] flex-1">
                  <Field label="Calendar for bookings">
                    {(p) => (
                      <Select id={p.id} value={selected} onChange={(e) => setSelected(e.target.value)}>
                        {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}{c.primary ? " (primary)" : ""}</option>)}
                      </Select>
                    )}
                  </Field>
                </div>
                <Button onClick={() => void saveCalendar()} loading={busy === "save"} disabled={!selected}>Save calendar</Button>
              </>
            ) : (
              <Button variant="secondary" onClick={() => void loadCalendars()} loading={busy === "calendars"}>{conn.calendarId ? "Change calendar" : "Choose calendar"}</Button>
            )}
            <Button variant="secondary" onClick={() => void retry()} loading={busy === "retry"}><RefreshCw className="size-4" aria-hidden /> Retry failed</Button>
            <Button variant="danger" onClick={() => void disconnect()} loading={busy === "disconnect"}><Unplug className="size-4" aria-hidden /> Disconnect</Button>
          </div>
        </div>
      ) : null}

      {notice ? <Alert tone="success" title="Done">{notice}</Alert> : null}
      {error ? <Alert tone="danger" title="Action failed">{error}</Alert> : null}

      {status.problems.length ? (
        <div>
          <h3 className="mb-2 font-medium">Needs attention</h3>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {status.problems.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  <Link className="font-medium text-brand hover:underline" href={`/dashboard/bookings/${p.bookingId}`}>{p.reference}</Link>{" "}
                  {p.externalState === "changed_in_google" ? "was edited in Google — Retry puts the CRM version back." : p.externalState === "deleted_in_google" ? "was deleted in Google — Retry re-creates it." : `failed after ${p.attempts} attempt${p.attempts === 1 ? "" : "s"}: ${p.lastError ?? "unknown error"}`}
                </span>
                <span className="text-xs text-muted">{fmt(p.updatedAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {conn ? (
      <p className="flex items-center gap-1 text-xs text-muted">
        <ArrowRight className="size-3" aria-hidden /> Changes are sent by the background worker, usually within a minute. Edits made in Google are detected hourly and reported here, not imported.
      </p>
      ) : null}
    </div>
  );
}
