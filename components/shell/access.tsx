import { Lock } from "lucide-react";
import { Card, EmptyState } from "@/components/ui/layout";

export function AccessDenied() {
  return (
    <Card>
      <EmptyState icon={Lock} title="You don’t have access to this page">
        Ask a superadmin if you need this permission.
      </EmptyState>
    </Card>
  );
}
