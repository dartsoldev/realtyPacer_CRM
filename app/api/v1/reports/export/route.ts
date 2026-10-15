import { requireApiUser } from "@/lib/auth/current-user";
import { z } from "zod";
import { parseBody, route } from "@/lib/http/api";
import { reportDefinitionSchema } from "@/modules/reports/definition";
import { exportReportCsv } from "@/modules/reports/csv";

export const runtime = "nodejs";

/** Server-side CSV of all authorized matching rows. Returned directly; no stored files or public links. */
export const POST = route(async (req) => {
  const user = await requireApiUser("reports:export");
  const { definition } = await parseBody(req, z.object({ definition: reportDefinitionSchema }).strict());
  const { filename, body } = await exportReportCsv(user, definition);
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" },
  });
});
