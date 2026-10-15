"use client";

import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";

/** Production builds hide server error details; only the digest is shown for support. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    <div className="space-y-4">
      <Alert tone="danger" title={offline ? "You’re offline" : "This page couldn’t be loaded"}>
        {offline ? "Reconnect, then try again. Nothing was changed." : "Something went wrong on our side. Nothing was changed."}{" "}
        {error.digest ? `If it keeps happening, give your administrator this reference: ${error.digest}` : null}
      </Alert>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={reset}>
          Try again
        </Button>
        <Link href="/dashboard" className={buttonClasses("ghost")}>
          Go to the dashboard
        </Link>
      </div>
    </div>
  );
}
