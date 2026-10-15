import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { runCustomerFilter } from "@/modules/reports/customer-filter";

export const runtime = "nodejs";

/** Simple customer & service filter: { conditions, columns, sort, page }. POST keeps filters out of URLs/logs. */
export const POST = route(async (req) => {
  const user = await requireApiUser("reports:read");
  return ok(await runCustomerFilter(user, await readBody(req)));
});
