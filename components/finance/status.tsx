import { Ban, CheckCircle2, FileLock2, PencilLine, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function PaymentStatusBadge({ status, refundState }: { status: "POSTED" | "REVERSED"; refundState: "none" | "partial" | "full" }) {
  if (status === "REVERSED") return <Badge tone="slate" icon={Ban}>Reversed</Badge>;
  if (refundState === "full") return <Badge tone="pending" icon={Undo2}>Fully refunded</Badge>;
  if (refundState === "partial") return <Badge tone="pending" icon={Undo2}>Partly refunded</Badge>;
  return <Badge tone="success" icon={CheckCircle2}>Posted</Badge>;
}

export function BillingStateBadge({ state }: { state: "DRAFT" | "FINALIZED" }) {
  return state === "FINALIZED" ? (
    <Badge tone="info" icon={FileLock2}>Charges finalized</Badge>
  ) : (
    <Badge tone="slate" icon={PencilLine}>Draft estimate</Badge>
  );
}
