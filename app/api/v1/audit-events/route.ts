import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, route } from "@/lib/http/api";
import { auditListQuery, listAuditEvents } from "@/modules/audit/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("audit:read");
  return ok(await listAuditEvents(user, parseQuery(req, auditListQuery)));
});
