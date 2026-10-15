import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { rotateLeadSourceSecret } from "@/modules/leads/intake";

export const runtime = "nodejs";

export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("integrations:manage");
  const res = ok(await rotateLeadSourceSecret(user, (await params).id));
  res.headers.set("Cache-Control", "no-store");
  return res;
});
