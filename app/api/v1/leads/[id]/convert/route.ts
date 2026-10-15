import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { convertLead } from "@/modules/leads/service";

export const runtime = "nodejs";

export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("leads:write");
  return ok(await convertLead(user, (await params).id, await readBody(req)));
});
