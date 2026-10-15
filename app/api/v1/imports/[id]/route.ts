import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, route } from "@/lib/http/api";
import { getImport } from "@/modules/imports/customers";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("customers:import");
  const q = parseQuery(req, z.object({ page: z.coerce.number().int().min(1).max(200).default(1), filter: z.enum(["all", "attention"]).default("all") }));
  return ok(await getImport(user, (await params).id, q.page, q.filter));
});
