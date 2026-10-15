"use client";

import { LogOut } from "lucide-react";
import { signOut } from "next-auth/react";
import { useState } from "react";
import { cn } from "@/components/ui/cn";

export function SignOutButton({ className, callbackUrl = "/login?reason=signed_out" }: { className?: string; callbackUrl?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await signOut({ callbackUrl });
      }}
      className={cn("inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-ink hover:bg-canvas disabled:opacity-60", className)}
    >
      <LogOut className="size-4" aria-hidden />
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
