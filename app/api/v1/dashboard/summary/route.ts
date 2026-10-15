import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { getDashboardSummary } from "@/modules/dashboard/service";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("dashboard:view");
  return ok(await getDashboardSummary(user));
});
