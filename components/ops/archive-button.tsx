"use client";

import { Archive, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/client/api";

export function ArchiveCustomerButton({ customerId, archived }: { customerId: string; archived: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <Button
        variant={archived ? "secondary" : "ghost"}
        size="sm"
        loading={busy}
        onClick={async () => {
          if (!archived && !window.confirm("Archive this customer? Their bookings, payments and history are kept; they just leave active lists.")) return;
          setBusy(true);
          const res = await apiRequest(`/api/v1/customers/${customerId}/archive`, { method: "POST", body: { archived: !archived } });
          setBusy(false);
          if (!res.ok) setError(res.message);
          router.refresh();
        }}
      >
        {archived ? <RotateCcw className="size-4" aria-hidden /> : <Archive className="size-4" aria-hidden />}
        {archived ? "Restore" : "Archive"}
      </Button>
      {error ? <span role="alert" className="text-xs text-danger">{error}</span> : null}
    </span>
  );
}
