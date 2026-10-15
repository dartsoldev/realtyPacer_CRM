"use client";

import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { LogoMark } from "@/components/brand/logo";
import { NavLinks } from "./nav-links";
import type { Terminology } from "./nav-config";

/**
 * Mobile drawer built on the native <dialog> element: focus is trapped while
 * open, Escape closes it, and focus returns to the menu button.
 */
export function MobileNav({ allowed, terminology, orgName, labels }: { allowed: string[]; terminology: Terminology; orgName: string; labels?: Record<string, string> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    ref.current?.close();
  }, [pathname]);

  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.showModal()}
        className="inline-flex size-10 items-center justify-center rounded-lg text-ink hover:bg-canvas lg:hidden"
        aria-label="Open navigation menu"
      >
        <Menu className="size-5" aria-hidden />
      </button>
      <dialog
        ref={ref}
        aria-label="Navigation"
        className="m-0 h-dvh max-h-dvh w-80 max-w-[85vw] bg-surface p-0 shadow-xl"
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close();
        }}
      >
        <div className="flex h-full flex-col">
          <div className="flex h-16 items-center justify-between border-b border-line px-4">
            <span className="flex items-center gap-2 font-semibold">
              <LogoMark className="size-7" />
              <span className="truncate">{orgName}</span>
            </span>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="inline-flex size-10 items-center justify-center rounded-lg hover:bg-canvas"
              aria-label="Close navigation menu"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <NavLinks allowed={allowed} terminology={terminology} labels={labels} onNavigate={() => ref.current?.close()} />
          </div>
        </div>
      </dialog>
    </>
  );
}
