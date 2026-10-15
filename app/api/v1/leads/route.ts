import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { createLead, leadListQuery, listLeads } from "@/modules/leads/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("leads:read");
  return ok(await listLeads(user, parseQuery(req, leadListQuery)));
});

export const POST = route(async (req) => {
  const user = await requireApiUser("leads:write");
  return ok(await createLead(user, await readBody(req)), 201);
});
