"use client";

import { Download, FileUp, Play } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/layout";
import { apiRequest } from "@/lib/client/api";
import type { ImportView } from "@/modules/imports/customers";

const MAX_BYTES = 2 * 1024 * 1024;
type Row = ImportView["rows"][number];
type Decision = { decision: "create" | "skip" | "update"; targetId?: string; overwrite: string[] };

/**
 * Customer CSV import: upload → map columns → review (validation, duplicates,
 * explicit decisions) → run in batches. Nothing is written until "Import".
 */
export function CustomerImport() {
  const [job, setJob] = useState<ImportView | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "attention">("attention");
  const [pending, setPending] = useState<Record<number, Decision>>({});

  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_BYTES) return setError("The file is larger than 2 MB. Split it into smaller files.");
    if (!/\.csv$/i.test(file.name)) return setError("Choose a .csv file (export it from your spreadsheet as CSV UTF-8).");
    setBusy(true);
    const csv = await file.text();
    const res = await apiRequest<{ id: string }>("/api/v1/imports/customers", { method: "POST", body: { fileName: file.name, csv } });
    if (!res.ok) {
      setBusy(false);
      return setError(res.fieldErrors ? (Object.values(res.fieldErrors)[0]?.[0] ?? res.message) : res.message);
    }
    const j = await apiRequest<ImportView>(`/api/v1/imports/${res.data.id}`);
    setBusy(false);
    if (j.ok) {
      setJob(j.data);
      setMapping(j.data.mapping);
    }
  }

  async function reload(id = job!.id, f = filter, page = 1) {
    const j = await apiRequest<ImportView>(`/api/v1/imports/${id}?filter=${f}&page=${page}`);
    if (j.ok) setJob(j.data);
    else setError(j.message);
  }

  async function preview() {
    setBusy(true);
    setError(null);
    const res = await apiRequest<ImportView>(`/api/v1/imports/${job!.id}/preview`, { method: "POST", body: { mapping } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setPending({});
    await reload(res.data.id, "attention");
    setFilter("attention");
  }

  async function saveDecisions(extra: Record<number, Decision> = {}) {
    const all = { ...pending, ...extra };
    const decisions = Object.entries(all).map(([n, d]) => ({ n: Number(n), ...d }));
    if (!decisions.length) return true;
    setBusy(true);
    const res = await apiRequest<ImportView>(`/api/v1/imports/${job!.id}/decisions`, { method: "POST", body: { expectedRevision: job!.revision, decisions } });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return false;
    }
    setPending({});
    await reload(job!.id, filter, job!.page);
    return true;
  }

  async function bulk(decision: "create" | "skip") {
    // Undecided rows only appear on the "needs attention" view; fetch them all page by page.
    const rows: Row[] = [];
    for (let p = 1; p <= 100; p++) {
      const r = await apiRequest<ImportView>(`/api/v1/imports/${job!.id}?filter=attention&page=${p}`);
      if (!r.ok) break;
      rows.push(...r.data.rows);
      if (p >= r.data.totalPages) break;
    }
    const extra: Record<number, Decision> = {};
    for (const r of rows) if (r.decision === null) extra[r.n] = { decision, overwrite: [] };
    await saveDecisions(extra);
  }

  async function run() {
    if (Object.keys(pending).length && !(await saveDecisions())) return;
    setBusy(true);
    setError(null);
    for (let i = 0; i < 200; i++) {
      const res = await apiRequest<ImportView>(`/api/v1/imports/${job!.id}/run`, { method: "POST" });
      if (!res.ok) {
        setBusy(false);
        return setError(`${res.message} You can safely press Import again to continue.`);
      }
      setJob(res.data);
      if (res.data.status === "completed") break;
    }
    setBusy(false);
    await reload(job!.id, "all");
    setFilter("all");
  }

  if (!job) {
    return (
      <Card>
        <CardHeader title="1. Choose a CSV file" description="Up to 2 MB and 5,000 customers. Payments and balances can't be imported this way." />
        <div className="space-y-4 p-5">
          {/* A file download from the API, not page navigation. */}
          <a href="/api/v1/imports/customers/template" download className="inline-flex items-center gap-2 text-sm font-medium text-brand underline-offset-4 hover:underline">
            <Download className="size-4" aria-hidden /> Download the template
          </a>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">CSV file</span>
            <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:py-2" />
          </label>
          {busy ? <p className="text-sm text-muted">Reading file…</p> : null}
          {error ? <Alert tone="danger" title="Couldn’t read the file">{error}</Alert> : null}
        </div>
      </Card>
    );
  }

  const t = job.totals;
  const started = job.status === "running" || job.status === "completed";
  return (
    <div className="space-y-6">
      {error ? <Alert tone="danger" title="Problem">{error}</Alert> : null}
      {job.status === "uploaded" || job.status === "previewed" ? (
        <Card>
          <CardHeader title="2. Match your columns" description={`${job.fileName || "File"} · ${t.rows} rows. Unmatched columns are ignored.`} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="bg-canvas text-left text-xs text-muted">
                <tr><th scope="col" className="px-4 py-2 font-medium">Column in your file</th><th scope="col" className="px-4 py-2 font-medium">Example values</th><th scope="col" className="px-4 py-2 font-medium">Import into</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {job.headers.map((h, i) => (
                  <tr key={i}>
                    <th scope="row" className="px-4 py-2 text-left font-medium">{h || `Column ${i + 1}`}</th>
                    <td className="px-4 py-2 text-muted">{job.sample.map((r) => r[i]).filter(Boolean).slice(0, 2).join(" · ") || "—"}</td>
                    <td className="px-4 py-2">
                      <select aria-label={`Import ${h || `column ${i + 1}`} into`} value={mapping[String(i)] ?? ""} onChange={(e) => setMapping((m) => { const next = { ...m }; if (e.target.value) next[String(i)] = e.target.value; else delete next[String(i)]; return next; })} className="h-10 w-full rounded-lg border border-line bg-surface px-2 text-base sm:text-sm">
                        <option value="">Don’t import</option>
                        {Object.entries(job.targets).map(([k, label]) => <option key={k} value={k} disabled={Object.entries(mapping).some(([col, v]) => v === k && col !== String(i))}>{label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2 border-t border-line p-4">
            <Button variant="secondary" onClick={() => setJob(null)}>Choose another file</Button>
            <Button onClick={() => void preview()} loading={busy}>Check rows</Button>
          </div>
        </Card>
      ) : null}

      {job.status !== "uploaded" ? (
        <Card>
          <CardHeader title={started ? "Import results" : "3. Review"} description={started ? `${t.done} of ${t.rows} rows processed` : "Rows with errors are skipped. Possible duplicates need your decision — nothing is merged automatically."} />
          <dl className="grid grid-cols-2 gap-3 p-4 text-sm sm:grid-cols-4">
            {(started
              ? [["Created", t.created], ["Updated", t.updated], ["Skipped", t.skipped], ["Failed", t.failed]]
              : [["Ready to create", t.toCreate], ["Will update", t.toUpdate], ["Will skip", t.toSkip], ["Need a decision", t.undecided]]
            ).map(([k, v]) => (
              <div key={k as string} className="rounded-lg border border-line p-3">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="text-xl font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {job.status === "running" ? <div className="mx-4 mb-4 h-2 overflow-hidden rounded bg-canvas" role="progressbar" aria-valuenow={t.done} aria-valuemin={0} aria-valuemax={t.rows} aria-label="Import progress"><div className="h-full bg-brand" style={{ width: `${(t.done / Math.max(1, t.rows)) * 100}%` }} /></div> : null}
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 text-sm">
            <label className="inline-flex items-center gap-2"><input type="radio" checked={filter === "attention"} onChange={() => { setFilter("attention"); void reload(job.id, "attention"); }} /> Needs attention</label>
            <label className="inline-flex items-center gap-2"><input type="radio" checked={filter === "all"} onChange={() => { setFilter("all"); void reload(job.id, "all"); }} /> All rows</label>
            {!started && t.undecided ? (
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => void bulk("skip")} loading={busy}>Skip all undecided</Button>
                <Button size="sm" variant="secondary" onClick={() => void bulk("create")} loading={busy}>Create all undecided as new</Button>
              </span>
            ) : null}
          </div>
          <ul className="divide-y divide-line">
            {job.rows.length === 0 ? <li className="px-4 py-6 text-sm text-muted">Nothing here.</li> : null}
            {job.rows.map((r) => {
              const d = pending[r.n] ?? (r.decision ? { decision: r.decision as Decision["decision"], targetId: r.targetId ?? undefined, overwrite: r.overwrite } : null);
              const blocked = r.errors.some((e) => !e.startsWith("Same "));
              return (
                <li key={r.n} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">Row {r.n}</span>
                    <span>{r.name || <span className="text-muted">(no name)</span>}</span>
                    <span className="text-muted">{r.contact}</span>
                    {r.result ? <Badge tone={r.result === "failed" ? "danger" : r.result === "skipped" ? "slate" : "success"}>{r.result}</Badge> : null}
                    {r.resultId && (r.result === "created" || r.result === "updated") ? <Link href={`/dashboard/customers/${r.resultId}`} className="text-brand underline">Open</Link> : null}
                  </div>
                  {r.errors.length ? <ul className="list-disc pl-5 text-danger">{r.errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
                  {r.resultError ? <p className="text-danger">{r.resultError}</p> : null}
                  {r.duplicates.length ? (
                    <p className="text-pending">Possible existing customer: {r.duplicates.map((x) => `${x.name} (same ${x.matchedOn.join(" and ")})`).join("; ")}</p>
                  ) : null}
                  {!started && !blocked ? (
                    <fieldset className="flex flex-wrap items-center gap-3">
                      <legend className="sr-only">Decision for row {r.n}</legend>
                      {(["create", "skip"] as const).map((k) => (
                        <label key={k} className="inline-flex items-center gap-1.5">
                          <input type="radio" name={`d-${r.n}`} checked={d?.decision === k} onChange={() => setPending((p) => ({ ...p, [r.n]: { decision: k, overwrite: [] } }))} />
                          {k === "create" ? (r.duplicates.length ? "Create as a new customer" : "Create") : "Skip"}
                        </label>
                      ))}
                      {r.duplicates.map((x) => (
                        <label key={x.customerId} className="inline-flex items-center gap-1.5">
                          <input type="radio" name={`d-${r.n}`} checked={d?.decision === "update" && d.targetId === x.customerId} onChange={() => setPending((p) => ({ ...p, [r.n]: { decision: "update", targetId: x.customerId, overwrite: [] } }))} />
                          Update {x.name} (fill blanks only)
                        </label>
                      ))}
                      {d?.decision === "update" ? (
                        <span className="flex w-full flex-wrap items-center gap-2 text-xs">
                          <span className="text-muted">Also replace existing:</span>
                          {job.updatableFields.map((f) => (
                            <label key={f} className="inline-flex items-center gap-1">
                              <input type="checkbox" checked={d.overwrite.includes(f)} onChange={(e) => setPending((p) => ({ ...p, [r.n]: { ...d, overwrite: e.target.checked ? [...d.overwrite, f] : d.overwrite.filter((x) => x !== f) } }))} />
                              {f}
                            </label>
                          ))}
                        </span>
                      ) : null}
                    </fieldset>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {job.totalPages > 1 ? (
            <div className="flex justify-between border-t border-line px-4 py-3 text-sm">
              <Button size="sm" variant="secondary" disabled={job.page <= 1} onClick={() => void reload(job.id, filter, job.page - 1)}>Previous</Button>
              <span className="text-muted">Page {job.page} of {job.totalPages}</span>
              <Button size="sm" variant="secondary" disabled={job.page >= job.totalPages} onClick={() => void reload(job.id, filter, job.page + 1)}>Next</Button>
            </div>
          ) : null}
          {job.status !== "completed" ? (
            <div className="flex flex-wrap justify-end gap-2 border-t border-line p-4">
              {Object.keys(pending).length ? <Button variant="secondary" onClick={() => void saveDecisions()} loading={busy}>Save decisions</Button> : null}
              <Button onClick={() => void run()} loading={busy} disabled={t.undecided > Object.keys(pending).length}>
                <Play className="size-4" aria-hidden /> {job.status === "running" ? "Continue import" : `Import ${t.toCreate + t.toUpdate} customers`}
              </Button>
            </div>
          ) : (
            <div className="flex justify-end border-t border-line p-4">
              <Button variant="secondary" onClick={() => { setJob(null); setError(null); }}>
                <FileUp className="size-4" aria-hidden /> Import another file
              </Button>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
