import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { cleanerListQuery, createCleaner, listCleaners } from "@/modules/cleaners/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("cleaners:read");
  return ok(await listCleaners(user, parseQuery(req, cleanerListQuery)));
});

/** Creates a profile only; no login access unless explicitly invited. */
export const POST = route(async (req) => {
  const user = await requireApiUser("cleaners:write");
  return ok(await createCleaner(user, await readBody(req)), 201);
});
