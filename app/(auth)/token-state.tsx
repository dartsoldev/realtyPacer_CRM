import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import type { TokenState } from "@/lib/auth/tokens";

/** Explains why a one-time link can't be used, with a way forward. */
export function TokenProblem({ state, what, retryHref, retryLabel }: { state: Exclude<TokenState, "valid">; what: string; retryHref: string; retryLabel: string }) {
  const copy = {
    expired: { title: `This ${what} has expired`, body: "For your security, links only work for a limited time." },
    used: { title: `This ${what} was already used`, body: "Each link works once. If that wasn’t you, request a new one." },
    invalid: { title: `This ${what} isn’t valid`, body: "It may be incomplete, or a newer link has replaced it." },
  }[state];
  return (
    <div className="space-y-4">
      <Alert tone={state === "expired" ? "pending" : "danger"} title={copy.title}>
        {copy.body}
      </Alert>
      <Link href={retryHref} className="inline-flex h-11 w-full items-center justify-center rounded-lg border border-line px-4 text-sm font-medium hover:bg-canvas">
        {retryLabel}
      </Link>
    </div>
  );
}
