"use client";

import { useEffect, useState } from "react";

/** Warns before leaving the page (reload/close/external navigation) while a form has unsaved changes. */
export function useUnsavedChangesWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}

/** Debounced value (for server-side autocomplete). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A stable random key per form session (idempotency for create requests). */
export function useIdempotencyKey() {
  const [key, setKey] = useState(newKey);
  return { key, renew: () => setKey(newKey()) };
}

function newKey(): string {
  // randomUUID needs a secure context; getRandomValues works everywhere.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b: number) => b.toString(16).padStart(2, "0")).join("");
}
