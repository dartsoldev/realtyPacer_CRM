"use client";

import { FileText, ImagePlus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/client/api";
import type { AttachmentItem } from "@/modules/attachments/service";

type Category = "property_photo" | "before_photo" | "after_photo" | "document";
const CATEGORY_LABELS: Record<Category, string> = { property_photo: "Property photo", before_photo: "Before", after_photo: "After", document: "Document (PDF)" };
const ACCEPT: Record<string, string> = { image: "image/jpeg,image/png,image/webp", document: "application/pdf" };

/**
 * Private photos/documents for an address or booking. Files upload directly to
 * private storage and are attached only after the server verifies them. Every
 * thumbnail and download goes through an authenticated route.
 */
export function AttachmentsPanel({
  parentType,
  parentId,
  categories,
  canUpload,
  configured,
  includeProperty,
}: {
  includeProperty?: boolean;
  parentType: "address" | "booking";
  parentId: string;
  categories: Category[];
  canUpload: boolean;
  configured: boolean;
}) {
  const [items, setItems] = useState<AttachmentItem[] | null>(null);
  const [category, setCategory] = useState<Category>(categories[0]!);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await apiRequest<{ items: AttachmentItem[] }>(`/api/v1/attachments?parentType=${parentType}&parentId=${parentId}${includeProperty ? "&includeProperty=1" : ""}`);
    if (r.ok) setItems(r.data.items);
    else setError(r.message);
  }, [parentType, parentId, includeProperty]);

  useEffect(() => {
    if (!configured) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load, configured]);

  async function upload(files: FileList) {
    setError(null);
    for (const file of Array.from(files).slice(0, 10)) {
      setBusy(`Uploading ${file.name}…`);
      const start = await apiRequest<{ attachmentId: string; uploadUrl: string; headers: Record<string, string> }>("/api/v1/attachments/uploads", {
        method: "POST",
        body: { parentType, parentId, category, fileName: file.name, contentType: file.type, size: file.size },
      });
      if (!start.ok) {
        setError(`${file.name}: ${start.message}`);
        continue;
      }
      try {
        const put = await fetch(start.data.uploadUrl, { method: "PUT", headers: start.data.headers, body: file });
        if (!put.ok) throw new Error(String(put.status));
      } catch {
        setError(`${file.name}: the upload to storage failed. Check your connection and try again.`);
        continue;
      }
      setBusy(`Checking ${file.name}…`);
      const done = await apiRequest(`/api/v1/attachments/${start.data.attachmentId}/complete`, { method: "POST" });
      if (!done.ok) setError(`${file.name}: ${done.message}`);
    }
    setBusy(null);
    if (input.current) input.current.value = "";
    await load();
  }

  async function remove(item: AttachmentItem) {
    if (!window.confirm(`Remove “${item.fileName}”? This can’t be undone.`)) return;
    const r = await apiRequest(`/api/v1/attachments/${item.id}`, { method: "DELETE" });
    if (!r.ok) setError(r.message);
    await load();
  }

  if (!configured) {
    return <p className="text-sm text-muted">Photos and documents need file storage, which isn’t set up yet. An administrator must configure S3-compatible storage (see the deployment guide).</p>;
  }
  const photos = items?.filter((i) => i.mimeType.startsWith("image/")) ?? [];
  const docs = items?.filter((i) => !i.mimeType.startsWith("image/")) ?? [];
  return (
    <div className="space-y-3">
      {canUpload ? (
        <div className="flex flex-wrap items-end gap-2">
          {categories.length > 1 ? (
            <label className="text-sm">
              <span className="mb-1 block font-medium">Type</span>
              <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className="h-10 rounded-lg border border-line bg-surface px-2 text-base sm:text-sm">
                {categories.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select>
            </label>
          ) : null}
          <input ref={input} type="file" multiple accept={category === "document" ? ACCEPT.document : ACCEPT.image} className="sr-only" id={`att-${parentId}`} onChange={(e) => e.target.files?.length && void upload(e.target.files)} />
          <Button type="button" variant="secondary" size="sm" className="h-10" disabled={Boolean(busy)} onClick={() => input.current?.click()}>
            <ImagePlus className="size-4" aria-hidden /> {category === "document" ? "Add PDF" : "Add photos"}
          </Button>
          <span className="text-xs text-muted">{category === "document" ? "PDF up to 20 MB" : "JPEG, PNG or WebP up to 15 MB"}</span>
        </div>
      ) : null}
      {busy ? <p role="status" className="text-sm text-muted">{busy}</p> : null}
      {error ? <Alert tone="danger" title="Upload problem">{error}</Alert> : null}
      {items === null ? <p className="text-sm text-muted">Loading files…</p> : items.length === 0 ? <p className="text-sm text-muted">No photos or documents yet.</p> : null}
      {photos.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {photos.map((p) => (
            <li key={p.id} className="overflow-hidden rounded-lg border border-line bg-canvas">
              <a href={p.url} target="_blank" rel="noopener" className="block" aria-label={`Open ${CATEGORY_LABELS[p.category]} ${p.fileName} in a new tab`}>
                {/* Private, authenticated image: not passed through the public image optimizer. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.thumbUrl ?? p.url}
                  alt={`${CATEGORY_LABELS[p.category]}: ${p.fileName}`}
                  width={480}
                  height={p.width && p.height ? Math.round((480 * p.height) / p.width) : 360}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[4/3] h-auto w-full object-cover"
                />
              </a>
              <div className="flex items-center justify-between gap-1 px-2 py-1 text-xs">
                <span className="truncate">{CATEGORY_LABELS[p.category]}</span>
                {p.canDelete ? (
                  <button type="button" onClick={() => void remove(p)} className="inline-flex min-h-8 min-w-8 items-center justify-center rounded text-muted hover:text-danger" aria-label={`Remove ${p.fileName}`}>
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {docs.length ? (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <a href={d.url} className="inline-flex items-center gap-2 text-brand underline-offset-4 hover:underline">
                <FileText className="size-4" aria-hidden /> {d.fileName} <span className="text-muted">({Math.ceil(d.size / 1024)} KB)</span>
              </a>
              {d.canDelete ? (
                <button type="button" onClick={() => void remove(d)} className="inline-flex min-h-8 min-w-8 items-center justify-center rounded text-muted hover:text-danger" aria-label={`Remove ${d.fileName}`}>
                  <Trash2 className="size-4" aria-hidden />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
