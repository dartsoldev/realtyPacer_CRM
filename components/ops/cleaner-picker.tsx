"use client";

import { X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/field";

type CleanerChoice = { id: string; name: string; phoneDisplay: string | null };

/**
 * Autocomplete for assigning cleaners: type part of a name or phone, pick from
 * the matches (keyboard: ↑ ↓ Enter, Esc). Selected cleaners show as removable
 * chips; none selected = “Unassigned”.
 */
export function CleanerPicker({ choices, value, onChange, disabled }: { choices: CleanerChoice[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const selected = value.map((v) => choices.find((c) => c.id === v)).filter(Boolean) as CleanerChoice[];
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    return choices
      .filter((c) => !value.includes(c.id))
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || (digits.length >= 2 && (c.phoneDisplay ?? "").replace(/\D/g, "").includes(digits)))
      .slice(0, 8);
  }, [q, choices, value]);
  const pick = (c: CleanerChoice) => {
    onChange([...value, c.id]);
    setQ("");
    setActive(0);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        {selected.length === 0 ? <Badge tone="pending">Unassigned</Badge> : null}
        {selected.map((c) => (
          <span key={c.id} className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 text-sm font-medium text-brand">
            {c.name}
            {!disabled ? (
              <button type="button" onClick={() => onChange(value.filter((v) => v !== c.id))} className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full hover:bg-white/60" aria-label={`Remove ${c.name}`}>
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {!disabled ? (
        <div className="relative max-w-md">
          <label htmlFor={`${id}-q`} className="sr-only">Find a cleaner</label>
          <Input
            id={`${id}-q`}
            role="combobox"
            aria-expanded={open && matches.length > 0}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={open && matches[active] ? `${id}-opt-${matches[active]!.id}` : undefined}
            placeholder={choices.length ? "Type a cleaner’s name or phone" : "No active cleaners"}
            disabled={choices.length === 0}
            autoComplete="off"
            value={q}
            onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, matches.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter" && open && matches[active]) { e.preventDefault(); pick(matches[active]!); }
              else if (e.key === "Escape") setOpen(false);
            }}
          />
          {open && matches.length ? (
            <ul id={`${id}-list`} role="listbox" aria-label="Matching cleaners" className="absolute z-20 mt-1 w-full divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
              {matches.map((c, i) => (
                <li
                  key={c.id}
                  id={`${id}-opt-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => { e.preventDefault(); pick(c); }}
                  className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-canvas" : ""}`}
                >
                  <span className="font-medium">{c.name}</span>
                  {c.phoneDisplay ? <span className="ml-2 text-muted">{c.phoneDisplay}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
