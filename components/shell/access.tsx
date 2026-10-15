import { Lock, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, EmptyState, PageHeader } from "@/components/ui/layout";

export function AccessDenied() {
  return (
    <Card>
      <EmptyState icon={Lock} title="You don’t have access to this page">
        Ask a superadmin if you need this permission.
      </EmptyState>
    </Card>
  );
}

/** Honest placeholder for modules scheduled in a later phase — no fake controls. */
export function ModuleComingNext({
  title,
  icon,
  phase,
  description,
  plans,
}: {
  title: string;
  icon: LucideIcon;
  phase: 2 | 3 | 4;
  description: string;
  plans: string[];
}) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card>
        <EmptyState icon={icon} title={`${title} isn’t available yet`} badge={<Badge tone="info">Coming in phase {phase}</Badge>}>
          <p>Nothing here is stored or simulated. When this module ships it will include:</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-left">
            {plans.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </EmptyState>
      </Card>
    </>
  );
}
