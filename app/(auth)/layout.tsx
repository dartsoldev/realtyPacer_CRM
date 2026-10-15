import type { Metadata } from "next";
import { Logo } from "@/components/brand/logo";

// Private, per-user content: always render on request, never prerender or cache.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <main className="rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">{children}</main>
      </div>
    </div>
  );
}
