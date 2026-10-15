"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/client/api";

export function RetryOutboxButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const r = await apiRequest(`/api/v1/system/outbox/${id}/retry`, { method: "POST" });
          setBusy(false);
          if (!r.ok) return setError(r.message);
          router.refresh();
        }}
      >
        <RotateCcw className="size-4" aria-hidden /> Retry
      </Button>
      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </span>
  );
}
