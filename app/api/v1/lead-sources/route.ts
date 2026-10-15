import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { createLeadSource, listLeadSources } from "@/modules/leads/intake";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("integrations:manage");
  return ok({ items: await listLeadSources(user) });
});

/** Returns the new source and its key; the key is not retrievable afterwards. */
export const POST = route(async (req) => {
  const user = await requireApiUser("integrations:manage");
  const res = ok(await createLeadSource(user, await readBody(req)), 201);
  res.headers.set("Cache-Control", "no-store");
  return res;
});
