import { requireApiUser } from "@/lib/auth/current-user";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/http/api";
import { reportDefinitionSchema } from "@/modules/reports/definition";
import { runReport } from "@/modules/reports/engine";

export const runtime = "nodejs";

/** POST (not a mutation) so filter definitions stay out of URLs and logs. */
export const POST = route(async (req) => {
  const user = await requireApiUser("reports:read");
  const body = await parseBody(req, z.object({ definition: reportDefinitionSchema, page: z.number().int().min(1).max(10_000).default(1), pageSize: z.number().int().min(1).max(100).default(25), lenient: z.boolean().default(false) }).strict());
  return ok(await runReport(user, body.definition, { page: body.page, pageSize: body.pageSize, lenient: body.lenient }));
});
