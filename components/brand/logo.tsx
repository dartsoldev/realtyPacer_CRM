import Link from "next/link";
import { cn } from "@/components/ui/cn";

/** Original RealtyPacer mark: a forward-leaning "pace" chevron in a rounded tile. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden focusable="false">
      <rect width="32" height="32" rx="8" fill="#DC2626" />
      <path d="M9 22.5 15.5 16 9 9.5" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 22.5 23 16l-6.5-6.5" fill="none" stroke="#fff" strokeOpacity=".65" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2 rounded-md font-semibold tracking-tight text-ink", className)}>
      <LogoMark />
      <span className="text-lg">
        Realty<span className="text-brand">Pacer</span>
      </span>
    </Link>
  );
}
