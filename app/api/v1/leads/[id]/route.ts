import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { getLead, updateLead } from "@/modules/leads/service";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("leads:read");
  return ok(await getLead(user, (await params).id));
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("leads:write");
  return ok(await updateLead(user, (await params).id, await readBody(req)));
});
