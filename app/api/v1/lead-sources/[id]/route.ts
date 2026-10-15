import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { updateLeadSource } from "@/modules/leads/intake";

export const runtime = "nodejs";

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("integrations:manage");
  return ok(await updateLeadSource(user, (await params).id, await readBody(req)));
});
