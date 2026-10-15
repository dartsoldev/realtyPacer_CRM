import type { Metadata } from "next";
import { Activity } from "lucide-react";
import { RetryOutboxButton } from "@/components/shell/system-actions";
import { AccessDenied } from "@/components/shell/access";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { formatDateTime } from "@/lib/domain/time";
import { systemStatus } from "@/modules/system/status";

export const metadata: Metadata = { title: "System status" };

function Status({ ok, okText = "OK", badText }: { ok: boolean; okText?: string; badText: string }) {
  return ok ? <Badge tone="success">{okText}</Badge> : <Badge tone="danger">{badText}</Badge>;
}

export default async function SystemPage() {
  const user = await requirePageUser("/dashboard/system");
  if (!can(user, "system:diagnostics")) return <AccessDenied />;
  const s = await systemStatus(user);
  const tz = user.organization.timezone;
  const rows: [string, React.ReactNode, string][] = [
    ["Database", <Status key="db" ok={s.database.ok} badText="Unreachable" />, s.database.latencyMs !== null ? `Ping ${s.database.latencyMs} ms` : "Check MONGODB_URI and network access"],
    ["Email (SMTP)", <Status key="em" ok={s.email.configured} okText="Configured" badText="Not configured" />, s.email.issues.join("; ") || "Delivery is attempted by the app (auth emails) and the worker (queued emails)."],
    ["Background worker", <Status key="wk" ok={s.worker.healthy} okText="Running" badText={s.worker.lastBeat ? "Stale" : "Never seen"} />, s.worker.lastBeat ? `Last heartbeat ${formatDateTime(s.worker.lastBeat, tz)} (${s.worker.ageSeconds}s ago)` : "Start it with “npm run worker” (or the worker container). Required for queued emails."],
    ["File storage", <Status key="st" ok={s.storage.configured} okText="Configured" badText="Not configured" />, s.storage.issues.join("; ") || (s.storage.configured ? "Private S3-compatible bucket" : "Photos and documents are unavailable until S3 settings are provided.")],
    ["Calling", s.calling.mode === "browser" ? <Status key="cl" ok={s.calling.configured} okText="Browser calling on" badText="Misconfigured" /> : <Badge key="cl" tone="slate">Phone app only</Badge>, s.calling.issues.join("; ") || (s.calling.mode === "browser" ? "Twilio Voice" : "CALLING_MODE=tel (default): numbers open the device's phone app.")],
  ];
  const c = s.outbox.counts;
  return (
    <>
      <PageHeader title="System status" description={`Version ${s.version} · Node ${s.node} · checked ${formatDateTime(s.checkedAt, tz)} — shows whether services are configured, never their secrets.`} />
      <Card>
        <CardHeader title="Services" />
        <ul className="divide-y divide-line">
          {rows.map(([name, badge, detail]) => (
            <li key={name} className="grid gap-1 px-5 py-3 text-sm sm:grid-cols-[12rem_10rem_1fr] sm:items-center">
              <span className="font-medium">{name}</span>
              <span>{badge}</span>
              <span className="text-muted">{detail}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="mt-6">
        <CardHeader title="Email outbox" description={`Sent ${c.sent ?? 0} · queued ${(c.pending ?? 0) + (c.sending ?? 0)} · failed ${c.failed ?? 0}`} />
        {s.outbox.attention.length === 0 ? (
          <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted"><Activity className="size-4" aria-hidden /> Nothing waiting or failed.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="bg-canvas text-left text-xs text-muted">
                <tr><th scope="col" className="px-4 py-2 font-medium">Created</th><th scope="col" className="px-4 py-2 font-medium">Email</th><th scope="col" className="px-4 py-2 font-medium">To</th><th scope="col" className="px-4 py-2 font-medium">Status</th><th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {s.outbox.attention.map((m) => (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap px-4 py-2">{formatDateTime(m.createdAt, tz)}</td>
                    <td className="px-4 py-2">{m.subject}</td>
                    <td className="px-4 py-2 text-muted">{m.to}</td>
                    <td className="px-4 py-2">
                      <Badge tone={m.status === "failed" ? "danger" : "pending"}>{m.status === "failed" ? "Failed" : m.status === "sending" ? "Sending" : "Queued"}</Badge>
                      <span className="block text-xs text-muted">{m.attempts} attempt(s){m.lastError ? ` · ${m.lastError}` : ""}{m.status === "pending" ? ` · next ${formatDateTime(m.nextAttemptAt, tz)}` : ""}</span>
                    </td>
                    <td className="px-4 py-2 text-right">{m.status === "failed" ? <RetryOutboxButton id={m.id} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
