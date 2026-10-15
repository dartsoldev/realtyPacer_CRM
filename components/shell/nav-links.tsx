"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/components/ui/cn";
import { NAV_ITEMS, type Terminology } from "./nav-config";

/**
 * Navigation filtered by the permissions the server resolved. Hiding links is
 * a convenience only — each page and API enforces access on its own.
 */
export function NavLinks({ allowed, terminology, onNavigate, labels = {} }: { allowed: string[]; terminology: Terminology; onNavigate?: () => void; labels?: Record<string, string> }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter((i) => allowed.includes(i.href));
  const sections = [
    { key: "main", title: null, items: items.filter((i) => i.section === "main") },
    { key: "more", title: "More", items: items.filter((i) => i.section === "more") },
    { key: "admin", title: "Administration", items: items.filter((i) => i.section === "admin") },
  ].filter((s) => s.items.length > 0);

  return (
    <nav aria-label="Main" className="space-y-6">
      {sections.map((s) => (
        <div key={s.key}>
          {s.title ? <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-muted">{s.title}</p> : null}
          <ul className="space-y-1">
            {s.items.map(({ href, label, icon: Icon }) => {
              const active = href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      active ? "bg-brand-soft text-brand" : "text-ink hover:bg-canvas",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    {labels[href] ?? label(terminology)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
