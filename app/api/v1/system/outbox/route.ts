import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { outboxOverview } from "@/modules/outbox/service";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("system:diagnostics");
  return ok(await outboxOverview(user));
});
