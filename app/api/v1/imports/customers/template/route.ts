import { requireApiUser } from "@/lib/auth/current-user";
import { route } from "@/lib/http/api";
import { importTemplate } from "@/modules/imports/customers";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("customers:import");
  return new Response(await importTemplate(user), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="realtypacer-customers-template.csv"', "Cache-Control": "private, no-store" },
  });
});
