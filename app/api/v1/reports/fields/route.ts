import { requireApiUser } from "@/lib/auth/current-user";
import { z } from "zod";
import { ok, parseQuery, route } from "@/lib/http/api";
import { REPORT_MODES } from "@/modules/reports/definition";
import { fieldsWithOptions } from "@/modules/reports/filters";

export const runtime = "nodejs";

/** Allowlisted filter fields (with options) for a report mode, filtered by the viewer's permissions. */
export const GET = route(async (req) => {
  const q = parseQuery(req, z.object({ mode: z.enum([...REPORT_MODES, "customer_list", "service_filter"]) }));
  const user = await requireApiUser(q.mode === "customer_list" ? "customers:read" : "reports:read");
  return ok({ fields: await fieldsWithOptions(user, q.mode) });
});
