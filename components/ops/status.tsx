import { Ban, CalendarClock, CheckCircle2, PlayCircle, UserX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BOOKING_STATUS_LABELS, type BookingStatus } from "@/lib/domain/constants";

/** Blue scheduled · amber in progress · green completed · red cancelled — always with a label and icon. */
export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const map = {
    SCHEDULED: { tone: "info", icon: CalendarClock },
    IN_PROGRESS: { tone: "pending", icon: PlayCircle },
    COMPLETED: { tone: "success", icon: CheckCircle2 },
    CANCELLED: { tone: "danger", icon: Ban },
  } as const;
  const { tone, icon } = map[status];
  return (
    <Badge tone={tone} icon={icon}>
      {BOOKING_STATUS_LABELS[status]}
    </Badge>
  );
}

export function UnassignedBadge() {
  return (
    <Badge tone="pending" icon={UserX}>
      Unassigned
    </Badge>
  );
}

export function ActiveBadge({ active, archived, activeLabel = "Active", inactiveLabel = "Inactive" }: { active: boolean; archived?: boolean; activeLabel?: string; inactiveLabel?: string }) {
  if (archived) return <Badge tone="slate" icon={Ban}>Archived</Badge>;
  return active ? (
    <Badge tone="success" icon={CheckCircle2}>
      {activeLabel}
    </Badge>
  ) : (
    <Badge tone="slate" icon={Ban}>
      {inactiveLabel}
    </Badge>
  );
}
