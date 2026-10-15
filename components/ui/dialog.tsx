"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { cn } from "./cn";

/**
 * Native <dialog> modal: focus trap, Escape to close, focus restored on close.
 * `wide` for forms with several columns. Mark the primary control with
 * `data-autofocus` to focus it on open.
 */
export function Modal({
  title,
  open,
  onClose,
  children,
  wide,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // Native dialogs focus the first control (the close button); prefer the
      // element the content marks as the primary target.
      el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby={titleId}
      className={cn(
        "m-auto rounded-2xl border border-line bg-surface p-0 text-left shadow-xl",
        wide ? "w-[min(48rem,calc(100vw-2rem))]" : "w-[min(32rem,calc(100vw-2rem))]",
      )}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <button type="button" onClick={onClose} className="inline-flex size-9 items-center justify-center rounded-lg hover:bg-canvas" aria-label="Close dialog">
          <X className="size-5" aria-hidden />
        </button>
      </div>
      <div className="max-h-[75dvh] overflow-y-auto p-5">{open ? children : null}</div>
    </dialog>
  );
}
