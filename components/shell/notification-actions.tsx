"use client";

import { CheckCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/client/api";

export function MarkAllReadButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        await apiRequest("/api/v1/notifications/read", { method: "POST", body: { all: true } });
        setBusy(false);
        router.refresh();
      }}
    >
      <CheckCheck className="size-4" aria-hidden /> Mark all as read
    </Button>
  );
}
