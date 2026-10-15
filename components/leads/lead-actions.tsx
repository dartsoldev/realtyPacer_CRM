"use client";

import { CalendarPlus, CheckCircle2, Plus, Upload, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { LEAD_CATEGORY_LABELS, LEAD_STATUS_LABELS, LEAD_STATUSES, RE_INTENT_LABELS, RE_INTENTS, type LeadCategory, type LeadStatus } from "@/lib/domain/leads";
import { parseAmountToCents } from "@/lib/domain/money";

const textarea = "block w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand";

type Staff = { id: string; name: string };

const EMPTY = {
  name: "", phone: "", email: "", city: "", address: "", source: "", receivedDate: "", notes: "", assignedTo: "",
  requestedService: "", preferredDate: "", serviceLocation: "",
  intent: "", areaOfInterest: "", budget: "", listingUrl: "",
};

/** Manual lead entry. Category decides which extra fields appear. */
export function AddLeadButton({ defaultCategory, staff, size = "md", variant = "primary" }: { defaultCategory: LeadCategory; staff: Staff[]; size?: "sm" | "md"; variant?: "primary" | "secondary" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<LeadCategory>(defaultCategory);
  const [v, setV] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV((s) => ({ ...s, [k]: e.target.value }));

  async function save() {
    setError(null);
    setErrors({});
    let budgetCents: number | null = null;
    if (category === "real_estate" && v.budget.trim()) {
      budgetCents = parseAmountToCents(v.budget.replace(/[,$\s]/g, ""));
      if (budgetCents === null) return setErrors({ budgetCents: "Enter an amount like 650000" });
    }
    setBusy(true);
    const common = { category, name: v.name, phone: v.phone, email: v.email, city: v.city, address: v.address, source: v.source, notes: v.notes, assignedTo: v.assignedTo || null, ...(v.receivedDate ? { receivedDate: v.receivedDate } : {}) };
    const body = category === "general" ? { ...common, requestedService: v.requestedService, preferredDate: v.preferredDate, serviceLocation: v.serviceLocation } : { ...common, intent: v.intent, areaOfInterest: v.areaOfInterest, budgetCents, listingUrl: v.listingUrl };
    const res = await apiRequest<{ id: string }>("/api/v1/leads", { method: "POST", body });
    setBusy(false);
    if (!res.ok) {
      setErrors(Object.fromEntries(Object.entries(res.fieldErrors ?? {}).map(([k, m]) => [k, m[0]!])));
      return setError(res.message);
    }
    setOpen(false);
    setV(EMPTY);
    router.push(`/dashboard/leads/${res.data.id}`);
  }

  return (
    <>
      <Button size={size} variant={variant} onClick={() => { setCategory(defaultCategory); setOpen(true); }}>
        <Plus className="size-4" aria-hidden /> Add lead
      </Button>
      <Modal title="Add lead" open={open} onClose={() => setOpen(false)} wide>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Category</legend>
            <div className="flex flex-wrap gap-2">
              {(["general", "real_estate"] as const).map((c) => (
                <label key={c} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${category === c ? "border-brand bg-brand-soft font-medium" : "border-line"}`}>
                  <input type="radio" name="category" value={c} checked={category === c} onChange={() => setCategory(c)} className="accent-brand" />
                  {LEAD_CATEGORY_LABELS[c]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required error={errors.name}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.name} onChange={set("name")} data-autofocus autoComplete="off" />}</Field>
            <Field label="Phone" error={errors.phone} hint="Phone or email is required">{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.phone} onChange={set("phone")} inputMode="tel" autoComplete="off" />}</Field>
            <Field label="Email (optional)" error={errors.email}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.email} onChange={set("email")} type="email" autoComplete="off" />}</Field>
            <Field label="City" error={errors.city}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.city} onChange={set("city")} />}</Field>
            <Field label="Address" error={errors.address}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.address} onChange={set("address")} />}</Field>
            <Field label="Source" hint="Where it came from, e.g. Referral, Phone call, Facebook" error={errors.source}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.source} onChange={set("source")} />}</Field>
            <Field label="Received date" hint="Leave blank for today" error={errors.receivedDate}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} type="date" value={v.receivedDate} onChange={set("receivedDate")} />}</Field>
            <Field label="Assigned to" error={errors.assignedTo}>
              {(p) => (
                <Select id={p.id} describedBy={p.describedBy} value={v.assignedTo} onChange={set("assignedTo")}>
                  <option value="">Unassigned</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              )}
            </Field>
          </div>
          {category === "general" ? (
            <div className="grid gap-4 rounded-lg border border-line p-4 sm:grid-cols-3">
              <Field label="Requested service" error={errors.requestedService}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.requestedService} onChange={set("requestedService")} />}</Field>
              <Field label="Preferred date" error={errors.preferredDate}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} type="date" value={v.preferredDate} onChange={set("preferredDate")} />}</Field>
              <Field label="Service location" error={errors.serviceLocation}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.serviceLocation} onChange={set("serviceLocation")} />}</Field>
            </div>
          ) : (
            <div className="grid gap-4 rounded-lg border border-line p-4 sm:grid-cols-2">
              <Field label="Looking to" error={errors.intent}>
                {(p) => (
                  <Select id={p.id} describedBy={p.describedBy} value={v.intent} onChange={set("intent")}>
                    <option value="">Not specified</option>
                    {RE_INTENTS.map((i) => <option key={i} value={i}>{RE_INTENT_LABELS[i]}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Area of interest" error={errors.areaOfInterest}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.areaOfInterest} onChange={set("areaOfInterest")} />}</Field>
              <Field label="Budget (optional)" error={errors.budgetCents}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.budget} onChange={set("budget")} inputMode="decimal" />}</Field>
              <Field label="Listing link (optional)" error={errors.listingUrl}>{(p) => <Input id={p.id} describedBy={p.describedBy} invalid={p.invalid} value={v.listingUrl} onChange={set("listingUrl")} type="url" placeholder="https://" />}</Field>
            </div>
          )}
          <Field label="Notes" error={errors.notes}>{(p) => <textarea id={p.id} aria-describedby={p.describedBy} className={textarea} rows={3} value={v.notes} onChange={set("notes")} maxLength={5000} />}</Field>
          {error ? <Alert tone="danger" title="Not saved">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={busy}>Save lead</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

type ImportResult = { committed: boolean; total: number; valid: number; duplicates: number; invalid: { row: number; error?: string }[]; created: number };

/** CSV import: preview first, then import. Re-importing the same rows adds nothing. */
export function LeadImportButton({ category }: { category: LeadCategory }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(commit: boolean) {
    if (!csv) return;
    setBusy(true);
    setError(null);
    const res = await apiRequest<ImportResult>("/api/v1/leads/import", { method: "POST", body: { category, csv, commit } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setResult(res.data);
    if (commit) router.refresh();
  }

  return (
    <>
      <Button variant="secondary" onClick={() => { setOpen(true); setCsv(null); setResult(null); setError(null); setFileName(""); }}>
        <Upload className="size-4" aria-hidden /> Import CSV
      </Button>
      <Modal title={`Import ${LEAD_CATEGORY_LABELS[category].toLowerCase()} leads`} open={open} onClose={() => setOpen(false)}>
        <div className="space-y-4 text-sm">
          <p className="text-muted">
            Columns recognised: Name, Phone, Email, City, Address, Source, Notes, Date, {category === "general" ? "Service, Preferred date, Location" : "Intent (buyer/seller/renter), Area, Budget, Listing"}. A name and a phone or email are required.
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="CSV file"
            className="block w-full text-sm"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              setResult(null);
              if (!f) return setCsv(null);
              if (f.size > 2 * 1024 * 1024) return setError("The file is larger than 2 MB.");
              setFileName(f.name);
              setCsv(await f.text());
            }}
          />
          {result ? (
            <Alert tone={result.committed ? "success" : "info"} title={result.committed ? `Imported ${result.created} lead${result.created === 1 ? "" : "s"}` : `Preview of ${fileName}`}>
              {result.total} rows · {result.committed ? result.created : result.valid} {result.committed ? "added" : "ready to add"} · {result.duplicates} already imported · {result.invalid.length} with problems
              {result.invalid.length ? (
                <ul className="mt-2 list-disc pl-5">
                  {result.invalid.slice(0, 8).map((r) => <li key={r.row}>Row {r.row}: {r.error}</li>)}
                </ul>
              ) : null}
            </Alert>
          ) : null}
          {error ? <Alert tone="danger" title="Import problem">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>{result?.committed ? "Close" : "Cancel"}</Button>
            {!result ? <Button onClick={() => void run(false)} disabled={!csv} loading={busy}>Preview</Button> : !result.committed ? <Button onClick={() => void run(true)} disabled={!result.valid} loading={busy}>Import {result.valid}</Button> : null}
          </div>
        </div>
      </Modal>
    </>
  );
}

/** Status, assignment and notes for one lead. */
export function LeadWorkflow({ leadId, status, assignedTo, staff }: { leadId: string; status: LeadStatus; assignedTo: string | null; staff: Staff[] }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function patch(body: Record<string, unknown>, which: string) {
    setBusy(which);
    setError(null);
    const res = await apiRequest(`/api/v1/leads/${leadId}`, { method: "PATCH", body });
    setBusy(null);
    if (!res.ok) return setError(res.message);
    if (which === "note") setNote("");
    router.refresh();
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-4">
        <Field label="Status">
          {(p) => (
            <Select id={p.id} value={status} disabled={busy !== null || status === "converted"} onChange={(e) => void patch({ status: e.target.value }, "status")}>
              {LEAD_STATUSES.filter((s) => s !== "converted" || status === "converted").map((s) => <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Assigned to">
          {(p) => (
            <Select id={p.id} value={assignedTo ?? ""} disabled={busy !== null} onChange={(e) => void patch({ assignedTo: e.target.value || null }, "assign")}>
              <option value="">Unassigned</option>
              {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}
        </Field>
      </div>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void patch({ note: note.trim() }, "note"); }}>
        <label htmlFor="lead-note" className="block text-sm font-medium">Add a note</label>
        <textarea id="lead-note" className={textarea} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        <div className="flex justify-end"><Button type="submit" size="sm" variant="secondary" disabled={!note.trim()} loading={busy === "note"}>Save note</Button></div>
      </form>
      {error ? <Alert tone="danger" title="Not saved">{error}</Alert> : null}
    </div>
  );
}

type Match = { id: string; name: string; phoneDisplay: string | null; email: string | null; city: string | null; archived: boolean; matchedOn: string[] };

/**
 * Convert to customer: shows existing customers with the same phone, email or
 * name first so staff can link instead of creating a duplicate.
 */
export function ConvertLeadPanel({ leadId, category, convertedCustomerId, preferredDate, canBook }: { leadId: string; category: LeadCategory; convertedCustomerId: string | null; preferredDate: string | null; canBook: boolean }) {
  const router = useRouter();
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [choice, setChoice] = useState<string>("new");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const bookHref = (customerId: string) => `/dashboard/bookings/new?customerId=${customerId}${preferredDate ? `&date=${preferredDate}` : ""}`;

  if (convertedCustomerId) {
    return (
      <div className="space-y-3 text-sm">
        <p className="flex items-center gap-2"><CheckCircle2 className="size-4 text-success" aria-hidden /> Converted. The lead keeps its original source and history.</p>
        <div className="flex flex-wrap gap-2">
          <Link href={`/dashboard/customers/${convertedCustomerId}`} className={buttonClasses("secondary", "sm")}>Open customer</Link>
          {category === "general" && canBook ? (
            <Link href={bookHref(convertedCustomerId)} className={buttonClasses("primary", "sm")}><CalendarPlus className="size-4" aria-hidden /> Book a service</Link>
          ) : null}
        </div>
      </div>
    );
  }

  async function loadMatches() {
    setError(null);
    const res = await apiRequest<{ items: Match[] }>(`/api/v1/leads/${leadId}/matches`);
    if (!res.ok) return setError(res.message);
    setMatches(res.data.items);
    setChoice(res.data.items.find((m) => !m.archived && (m.matchedOn.includes("phone") || m.matchedOn.includes("email")))?.id ?? "new");
  }

  async function convert() {
    setBusy(true);
    setError(null);
    const res = await apiRequest<{ customerId: string }>(`/api/v1/leads/${leadId}/convert`, { method: "POST", body: choice === "new" ? { create: true } : { customerId: choice } });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    router.refresh();
  }

  if (!matches) {
    return (
      <div className="space-y-2">
        <Button onClick={() => void loadMatches()}><UserPlus className="size-4" aria-hidden /> Convert to customer</Button>
        {error ? <Alert tone="danger" title="Could not check customers">{error}</Alert> : null}
      </div>
    );
  }
  return (
    <fieldset className="space-y-3 text-sm">
      <legend className="mb-1 font-medium">{matches.length ? "Possible existing customers" : "No existing customer matches this phone, email or name."}</legend>
      {matches.map((m) => (
        <label key={m.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${choice === m.id ? "border-brand bg-brand-soft" : "border-line"}`}>
          <input type="radio" name="convert-choice" className="mt-1 accent-brand" checked={choice === m.id} onChange={() => setChoice(m.id)} />
          <span>
            <span className="font-medium">Use {m.name}</span> {m.archived ? <Badge tone="slate">Archived</Badge> : null}
            <span className="block text-muted">{[m.phoneDisplay, m.email, m.city].filter(Boolean).join(" · ")} · matches {m.matchedOn.join(", ")}</span>
          </span>
        </label>
      ))}
      <label className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 ${choice === "new" ? "border-brand bg-brand-soft" : "border-line"}`}>
        <input type="radio" name="convert-choice" className="accent-brand" checked={choice === "new"} onChange={() => setChoice("new")} />
        <span className="font-medium">Create a new customer from this lead</span>
      </label>
      {error ? <Alert tone="danger" title="Not converted">{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={() => setMatches(null)}>Cancel</Button>
        <Button size="sm" onClick={() => void convert()} loading={busy}>{choice === "new" ? "Create customer" : "Link to customer"}</Button>
      </div>
    </fieldset>
  );
}
