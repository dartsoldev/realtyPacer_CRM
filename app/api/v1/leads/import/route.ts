import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { enforce, RATE_LIMITS } from "@/lib/security/rate-limit";
import { importLeadsCsv } from "@/modules/leads/service";

export const runtime = "nodejs";

/** CSV text in JSON: preview (commit=false) then import (commit=true). Re-importing the same rows is ignored. */
export const POST = route(async (req) => {
  const user = await requireApiUser("leads:write");
  await enforce([[RATE_LIMITS.importByUser, user.id]]);
  return ok(await importLeadsCsv(user, await readBody(req, 2.5 * 1024 * 1024)));
});
