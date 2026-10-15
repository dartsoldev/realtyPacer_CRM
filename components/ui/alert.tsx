import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "./cn";

type Tone = "success" | "danger" | "pending" | "info";

const tones: Record<Tone, { cls: string; Icon: typeof Info; label: string }> = {
  success: { cls: "border-success/30 bg-success-soft text-success", Icon: CheckCircle2, label: "Success" },
  danger: { cls: "border-danger/30 bg-danger-soft text-danger", Icon: XCircle, label: "Error" },
  pending: { cls: "border-pending/30 bg-pending-soft text-pending", Icon: AlertTriangle, label: "Warning" },
  info: { cls: "border-info/30 bg-info-soft text-info", Icon: Info, label: "Information" },
};

/** Status message with icon + visually hidden tone label (never colour alone). */
export function Alert({ tone = "info", title, children, className }: { tone?: Tone; title?: string; children?: React.ReactNode; className?: string }) {
  const { cls, Icon, label } = tones[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex gap-3 rounded-lg border p-3 text-sm", cls, className)}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-1">
        <p className="font-semibold">
          <span className="sr-only">{label}: </span>
          {title ?? label}
        </p>
        {children ? <div className="text-ink">{children}</div> : null}
      </div>
    </div>
  );
}
