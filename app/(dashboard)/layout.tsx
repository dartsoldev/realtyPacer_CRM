import type { Metadata } from "next";
import Link from "next/link";
import { CircleUserRound } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { MobileNav } from "@/components/shell/mobile-nav";
import { NAV_ITEMS } from "@/components/shell/nav-config";
import { NavLinks } from "@/components/shell/nav-links";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { SetupRequired } from "@/components/setup-required";
import { RoleBadge } from "@/components/ui/badge";
import { requirePageUser } from "@/lib/auth/page-guard";
import { getConfigStatus } from "@/lib/env";

// Private, per-user content: always render on request, never prerender or cache.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Dashboard", template: "%s · RealtyPacer" },
  robots: { index: false, follow: false, nocache: true },
};

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const config = getConfigStatus("core");
  if (!config.ok) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <SetupRequired issues={config.issues} />
      </main>
    );
  }
  const user = await requirePageUser("/dashboard");
  const allowed = NAV_ITEMS.filter((i) => user.permissions.has(i.permission)).map((i) => i.href);
  const terminology = user.organization.terminology;
  // Cleaners see their own jobs on the dashboard.
  const navLabels = !user.permissions.has("bookings:read") && user.permissions.has("bookings:read_assigned") ? { "/dashboard": "My jobs" } : undefined;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16rem_1fr]">
      <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="hidden border-r border-line bg-surface lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <div className="flex h-16 items-center border-b border-line px-5">
          <Logo href="/dashboard" />
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <NavLinks allowed={allowed} terminology={terminology} labels={navLabels} />
        </div>
        <div className="border-t border-line p-3 text-xs text-muted">
          <p className="truncate px-3">{user.organization.displayName}</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <MobileNav allowed={allowed} terminology={terminology} orgName={user.organization.displayName} labels={navLabels} />
            <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink lg:text-base">{user.organization.displayName}</p>
            <div className="flex items-center gap-1 sm:gap-2">
              <Link href="/dashboard/account" className="hidden items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-canvas sm:inline-flex">
                <CircleUserRound className="size-5 text-muted" aria-hidden />
                <span className="max-w-40 truncate font-medium">{user.name}</span>
                <RoleBadge role={user.role} />
              </Link>
              <Link href="/dashboard/account" className="inline-flex size-10 items-center justify-center rounded-lg hover:bg-canvas sm:hidden" aria-label="Your account">
                <CircleUserRound className="size-5" aria-hidden />
              </Link>
              <SignOutButton />
            </div>
          </div>
        </header>
        <main id="content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
