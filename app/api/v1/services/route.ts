import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { createService, listServices, serviceListQuery } from "@/modules/catalog/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("services:read");
  return ok(await listServices(user, parseQuery(req, serviceListQuery)));
});

export const POST = route(async (req) => {
  const user = await requireApiUser("services:write");
  return ok(await createService(user, await readBody(req)), 201);
});
