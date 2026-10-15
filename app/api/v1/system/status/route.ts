import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { systemStatus } from "@/modules/system/status";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("system:diagnostics");
  return ok(await systemStatus(user));
});
