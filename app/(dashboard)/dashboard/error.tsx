"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** Production builds hide server error details; only the digest is shown for support. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="space-y-4">
      <Alert tone="danger" title="This page couldn’t be loaded">
        Something went wrong on our side. Nothing was changed. {error.digest ? `Reference: ${error.digest}` : null}
      </Alert>
      <Button variant="secondary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
