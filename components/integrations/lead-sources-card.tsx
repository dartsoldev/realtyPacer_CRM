"use client";

import { Copy, KeyRound, Plus, ScrollText, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { LEAD_CATEGORY_LABELS, type LeadCategory } from "@/lib/domain/leads";

export type LeadSourceView = {
  id: string;
  name: string;
  slug: string;
  endpoint: string;
  defaultCategory: LeadCategory;
  fieldMap: Record<string, string>;
  secretHint: string;
  active: boolean;
  lastReceivedAt: string | null;
  receivedCount: number;
};

const TARGETS: { value: string; label: string }[] = [
  { value: "name", label: "Full name" },
  { value: "firstName", label: "First name" },
  { value: "lastName", label: "Last name" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "city", label: "City" },
  { value: "address", label: "Address" },
  { value: "notes", label: "Notes / message" },
  { value: "requestedService", label: "Requested service (service leads)" },
  { value: "preferredDate", label: "Preferred date (service leads)" },
  { value: "serviceLocation", label: "Service location (service leads)" },
  { value: "intent", label: "Buyer / seller / renter (real estate)" },
  { value: "areaOfInterest", label: "Area of interest (real estate)" },
  { value: "budget", label: "Budget (real estate)" },
  { value: "listingUrl", label: "Listing link (real estate)" },
  { value: "category", label: "Lead category override" },
  { value: "externalId", label: "Submission / entry id (prevents duplicates)" },
];

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "Nothing received yet");

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable: the value is visible to select */
        }
      }}
    >
      <Copy className="size-4" aria-hidden /> {done ? "Copied" : label}
    </Button>
  );
}

function KeyOnce({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <Alert tone="pending" title="Copy this key now — it will not be shown again">
      <p className="mb-2">Store it in your website server&apos;s settings (environment variable or plugin secret field). Never put it in page JavaScript or HTML.</p>
      <code className="mb-2 block break-all rounded bg-surface px-2 py-1 font-mono text-xs">{secret}</code>
      <div className="flex gap-2">
        <CopyButton text={secret} label="Copy key" />
        <Button size="sm" variant="secondary" onClick={onDone}>I stored it</Button>
      </div>
    </Alert>
  );
}

function MappingEditor({ source, onSaved }: { source: LeadSourceView; onSaved: () => void }) {
  const [rows, setRows] = useState<{ from: string; to: string }[]>(Object.entries(source.fieldMap).map(([from, to]) => ({ from, to })));
  const [category, setCategory] = useState<LeadCategory>(source.defaultCategory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    const fieldMap = Object.fromEntries(rows.filter((r) => r.from.trim()).map((r) => [r.from.trim(), r.to]));
    const res = await apiRequest(`/api/v1/lead-sources/${source.id}`, { method: "PATCH", body: { fieldMap, defaultCategory: category } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    onSaved();
  }
  return (
    <div className="space-y-3 text-sm">
      <Field label="Default lead category" hint="Used unless the form sends a mapped category field.">
        {(p) => (
          <Select id={p.id} value={category} onChange={(e) => setCategory(e.target.value as LeadCategory)}>
            <option value="general">{LEAD_CATEGORY_LABELS.general}</option>
            <option value="real_estate">{LEAD_CATEGORY_LABELS.real_estate}</option>
          </Select>
        )}
      </Field>
      <p className="text-muted">Map your form&apos;s field names to lead fields. Common names (name, phone, email, message, city…) are recognised without mapping. Unmapped fields are kept in the lead&apos;s notes.</p>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input aria-label="Form field name" placeholder="e.g. your-name or input_3" value={r.from} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, from: e.target.value } : y)))} className="min-w-0 flex-1" />
          <span aria-hidden>→</span>
          <Select aria-label="Lead field" value={r.to} onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, to: e.target.value } : y)))} className="min-w-0 flex-1">
            {TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </Select>
          <button type="button" className="inline-flex size-11 items-center justify-center rounded-lg text-muted hover:bg-canvas" aria-label={`Remove mapping ${r.from}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
            <Trash2 className="size-4" aria-hidden />
          </button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => setRows((x) => [...x, { from: "", to: "name" }])} disabled={rows.length >= 40}>
        <Plus className="size-4" aria-hidden /> Add mapping
      </Button>
      {error ? <Alert tone="danger" title="Not saved">{error}</Alert> : null}
      <div className="flex justify-end"><Button onClick={() => void save()} loading={busy}>Save mapping</Button></div>
    </div>
  );
}

type LogRow = { at: string; outcome: string; externalId: string | null; leadId: string | null; error: string | null };

function exampleFor(s: LeadSourceView) {
  const body = s.defaultCategory === "real_estate"
    ? `{"submission_id":"1001","name":"Jordan Example","phone":"416-555-0100","email":"jordan@example.com","city":"Mississauga","intent":"buyer","area":"Port Credit","budget":"750000"}`
    : `{"submission_id":"1001","name":"Jordan Example","phone":"416-555-0100","email":"jordan@example.com","city":"Mississauga","service":"Sofa cleaning","preferred_date":"2026-11-02","message":"Two sofas"}`;
  return {
    curl: `curl -X POST "${s.endpoint}" \\\n  -H "Authorization: Bearer $REALTYPACER_LEAD_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`,
    node: `// Runs on your website's SERVER (e.g. a form handler or webhook relay) — never in the browser.\nconst res = await fetch("${s.endpoint}", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.REALTYPACER_LEAD_KEY}\`,\n    "Content-Type": "application/json",\n    "Idempotency-Key": String(entry.id), // same id on retries = no duplicate lead\n  },\n  body: JSON.stringify(entry.fields),\n});\n// 201 created · 200 already received · 401 bad key · 422 missing name/contact · 429 slow down`,
  };
}

export function LeadSourcesCard({ sources }: { sources: LeadSourceView[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<LeadCategory>("general");
  const [secret, setSecret] = useState<{ id: string; value: string } | null>(null);
  const [mapping, setMapping] = useState<LeadSourceView | null>(null);
  const [logs, setLogs] = useState<{ source: LeadSourceView; rows: LogRow[] } | null>(null);
  const [example, setExample] = useState<LeadSourceView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy("create");
    setError(null);
    const res = await apiRequest<{ source: LeadSourceView; secret: string }>("/api/v1/lead-sources", { method: "POST", body: { name, defaultCategory: category } });
    setBusy(null);
    if (!res.ok) return setError(res.message);
    setCreateOpen(false);
    setName("");
    setSecret({ id: res.data.source.id, value: res.data.secret });
    router.refresh();
  }
  async function rotate(s: LeadSourceView) {
    if (!window.confirm(`Issue a new key for “${s.name}”? The current key stops working immediately.`)) return;
    setBusy(`rotate:${s.id}`);
    const res = await apiRequest<{ secret: string }>(`/api/v1/lead-sources/${s.id}/rotate`, { method: "POST" });
    setBusy(null);
    if (!res.ok) return setError(res.message);
    setSecret({ id: s.id, value: res.data.secret });
  }
  async function toggle(s: LeadSourceView) {
    setBusy(`toggle:${s.id}`);
    const res = await apiRequest(`/api/v1/lead-sources/${s.id}`, { method: "PATCH", body: { active: !s.active } });
    setBusy(null);
    if (!res.ok) return setError(res.message);
    router.refresh();
  }
  async function openLogs(s: LeadSourceView) {
    const res = await apiRequest<{ items: LogRow[] }>(`/api/v1/lead-sources/${s.id}/logs`);
    if (!res.ok) return setError(res.message);
    setLogs({ source: s, rows: res.data.items });
  }

  return (
    <div className="space-y-4 p-5 text-sm">
      <p className="text-muted">
        Website forms send leads to RealtyPacer from your website&apos;s server with a private key. Adding a website address alone does not import anything. Create one source per form (for example one for the cleaning quote form and one for the real estate enquiry form).
      </p>
      <Alert tone="info" title="To connect a form we still need from you">
        <ul className="list-disc pl-5">
          <li>Which form tool or website platform sends each form (for example WordPress with Contact Form 7, Gravity Forms, WPForms, Elementor, Wix, Squarespace, Webflow, or custom code).</li>
          <li>Whether that tool can send a server-side webhook (HTTP POST with a custom Authorization header), or whether a small relay (e.g. a WordPress snippet, Zapier/Make) is needed.</li>
          <li>The form&apos;s field names, so they can be mapped below.</li>
        </ul>
      </Alert>
      {secret ? <KeyOnce secret={secret.value} onDone={() => setSecret(null)} /> : null}
      {error ? <Alert tone="danger" title="Action failed">{error}</Alert> : null}
      {sources.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {sources.map((s) => (
            <li key={s.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <Badge tone="purple">{LEAD_CATEGORY_LABELS[s.defaultCategory]}</Badge>
                {s.active ? <Badge tone="success">Accepting</Badge> : <Badge tone="slate">Paused</Badge>}
                <span className="text-xs text-muted">Key {s.secretHint} · {s.receivedCount} received · last: {fmt(s.lastReceivedAt)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <code className="break-all rounded bg-canvas px-2 py-1 font-mono text-xs">POST {s.endpoint}</code>
                <CopyButton text={s.endpoint} label="Copy URL" />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setMapping(s)}>Field mapping</Button>
                <Button size="sm" variant="secondary" onClick={() => setExample(s)}>Integration example</Button>
                <Button size="sm" variant="secondary" onClick={() => void openLogs(s)}><ScrollText className="size-4" aria-hidden /> Submission log</Button>
                <Button size="sm" variant="secondary" onClick={() => void rotate(s)} loading={busy === `rotate:${s.id}`}><KeyRound className="size-4" aria-hidden /> New key</Button>
                <Button size="sm" variant="secondary" onClick={() => void toggle(s)} loading={busy === `toggle:${s.id}`}>{s.active ? "Pause" : "Resume"}</Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-line p-4 text-center text-muted">No website forms connected. No leads are being imported automatically.</p>
      )}
      <Button onClick={() => setCreateOpen(true)}><Plus className="size-4" aria-hidden /> Add lead source</Button>

      <Modal title="Add lead source" open={createOpen} onClose={() => setCreateOpen(false)}>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Field label="Name" required hint="e.g. Website – cleaning quote form">{(p) => <Input id={p.id} describedBy={p.describedBy} value={name} onChange={(e) => setName(e.target.value)} data-autofocus maxLength={120} />}</Field>
          <Field label="Lead category">
            {(p) => (
              <Select id={p.id} value={category} onChange={(e) => setCategory(e.target.value as LeadCategory)}>
                <option value="general">{LEAD_CATEGORY_LABELS.general}</option>
                <option value="real_estate">{LEAD_CATEGORY_LABELS.real_estate}</option>
              </Select>
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="submit" loading={busy === "create"} disabled={!name.trim()}>Create and show key</Button>
          </div>
        </form>
      </Modal>
      <Modal title={mapping ? `Field mapping — ${mapping.name}` : ""} open={Boolean(mapping)} onClose={() => setMapping(null)} wide>
        {mapping ? <MappingEditor source={mapping} onSaved={() => { setMapping(null); router.refresh(); }} /> : null}
      </Modal>
      <Modal title={example ? `Integration example — ${example.name}` : ""} open={Boolean(example)} onClose={() => setExample(null)} wide>
        {example ? (
          <div className="space-y-3 text-sm">
            <p>Send each submission from your server. Accepted bodies: JSON or URL-encoded form data. Include a submission id (mapped field or <code>Idempotency-Key</code> header) so retries never create duplicates; without one, an identical body counts as the same submission.</p>
            <h3 className="font-medium">Test with curl</h3>
            <pre className="overflow-x-auto rounded-lg bg-canvas p-3 font-mono text-xs">{exampleFor(example).curl}</pre>
            <h3 className="font-medium">Server-side JavaScript</h3>
            <pre className="overflow-x-auto rounded-lg bg-canvas p-3 font-mono text-xs">{exampleFor(example).node}</pre>
          </div>
        ) : null}
      </Modal>
      <Modal title={logs ? `Submission log — ${logs.source.name}` : ""} open={Boolean(logs)} onClose={() => setLogs(null)} wide>
        {logs ? (
          logs.rows.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted"><tr><th className="py-1">When</th><th>Outcome</th><th>Submission id</th><th>Detail</th></tr></thead>
              <tbody className="divide-y divide-line">
                {logs.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="py-1.5 pr-2">{fmt(r.at)}</td>
                    <td className="pr-2"><Badge tone={r.outcome === "accepted" ? "success" : r.outcome === "duplicate" ? "info" : "danger"}>{r.outcome}</Badge></td>
                    <td className="break-all pr-2 font-mono text-xs">{r.externalId ?? "—"}</td>
                    <td>{r.leadId ? <a className="text-brand hover:underline" href={`/dashboard/leads/${r.leadId}`}>Open lead</a> : (r.error ?? "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-muted">No submissions in the last 90 days.</p>
          )
        ) : null}
      </Modal>
    </div>
  );
}
