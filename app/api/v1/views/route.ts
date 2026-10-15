import { requireApiUser } from "@/lib/auth/current-user";
import { z } from "zod";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { createView, listViews } from "@/modules/reports/views";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("reports:read");
  const q = parseQuery(req, z.object({ reportType: z.string().max(20).optional() }));
  return ok({ items: await listViews(user, q.reportType) });
});

export const POST = route(async (req) => {
  const user = await requireApiUser("reports:read");
  return ok(await createView(user, await readBody(req)), 201);
});
