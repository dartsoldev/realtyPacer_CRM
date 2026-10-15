import { Ban, CheckCircle2, Clock, Info, Mail, ShieldCheck, type LucideIcon } from "lucide-react";
import type { Role, UserStatus } from "@/lib/domain/constants";
import { ROLE_LABELS, STATUS_LABELS } from "@/lib/domain/constants";
import { cn } from "./cn";

type Tone = "success" | "danger" | "pending" | "info" | "purple" | "teal" | "slate";

const tones: Record<Tone, string> = {
  success: "bg-success-soft text-success ring-success/25",
  danger: "bg-danger-soft text-danger ring-danger/25",
  pending: "bg-pending-soft text-pending ring-pending/25",
  info: "bg-info-soft text-info ring-info/25",
  purple: "bg-tag-purple-soft text-tag-purple ring-tag-purple/25",
  teal: "bg-tag-teal-soft text-tag-teal ring-tag-teal/25",
  slate: "bg-tag-slate-soft text-tag-slate ring-tag-slate/25",
};

/** Badge always carries text (and usually an icon) — colour is never the only signal. */
export function Badge({ tone = "slate", icon: Icon, children, className }: { tone?: Tone; icon?: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", tones[tone], className)}>
      {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function UserStatusBadge({ status }: { status: UserStatus }) {
  const map: Record<UserStatus, { tone: Tone; icon: LucideIcon }> = {
    active: { tone: "success", icon: CheckCircle2 },
    invited: { tone: "pending", icon: Mail },
    suspended: { tone: "danger", icon: Ban },
  };
  return (
    <Badge tone={map[status].tone} icon={map[status].icon}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  const tone: Record<Role, Tone> = { SUPERADMIN: "purple", ADMIN: "info", STAFF: "slate", CLEANER: "teal" };
  return (
    <Badge tone={tone[role]} icon={role === "SUPERADMIN" ? ShieldCheck : undefined}>
      {ROLE_LABELS[role]}
    </Badge>
  );
}

export function DeliveryBadge({ status, expired }: { status: "pending" | "sent" | "failed" | "not_sent"; expired: boolean }) {
  if (expired) return <Badge tone="slate" icon={Clock}>Invite expired</Badge>;
  if (status === "sent") return <Badge tone="info" icon={Info}>Invite email sent</Badge>;
  if (status === "failed") return <Badge tone="danger" icon={Ban}>Email failed</Badge>;
  return <Badge tone="pending" icon={Clock}>Not sent</Badge>;
}
