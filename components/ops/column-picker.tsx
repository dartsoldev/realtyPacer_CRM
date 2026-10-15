"use client";

import { Columns3 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

const STORAGE_KEY = "rp.customerColumns";

/**
 * Visible-column chooser. The choice lives in the URL (?cols=) so the server
 * renders exactly those columns; it is also remembered per browser.
 */
export function ColumnPicker({ options, selected }: { options: { key: string; label: string }[]; selected: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  // Restore the remembered choice once, if the URL doesn't specify one.
  useEffect(() => {
    if (params.has("cols")) return;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && saved !== selected.join(",")) {
        const sp = new URLSearchParams(params.toString());
        sp.set("cols", saved);
        router.replace(`${pathname}?${sp.toString()}`);
      }
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(key: string, on: boolean) {
    const next = options.map((o) => o.key).filter((k) => (k === key ? on : selected.includes(k)));
    const sp = new URLSearchParams(params.toString());
    sp.set("cols", next.join(",") || "none");
    try {
      localStorage.setItem(STORAGE_KEY, next.join(",") || "none");
    } catch {
      /* ignore */
    }
    router.replace(`${pathname}?${sp.toString()}`);
  }

  return (
    <details className="relative">
      <summary className="inline-flex h-10 cursor-pointer list-none items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:bg-canvas [&::-webkit-details-marker]:hidden">
        <Columns3 className="size-4" aria-hidden /> Columns
      </summary>
      <fieldset className="absolute right-0 z-20 mt-2 w-56 space-y-2 rounded-xl border border-line bg-surface p-3 shadow-lg">
        <legend className="sr-only">Visible columns</legend>
        {options.map((o) => (
          <label key={o.key} className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand" checked={selected.includes(o.key)} onChange={(e) => toggle(o.key, e.target.checked)} />
            {o.label}
          </label>
        ))}
      </fieldset>
    </details>
  );
}
