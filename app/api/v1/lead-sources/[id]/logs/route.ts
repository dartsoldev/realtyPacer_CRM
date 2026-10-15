import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { leadSourceLogs } from "@/modules/leads/intake";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("integrations:manage");
  return ok({ items: await leadSourceLogs(user, (await params).id) });
});
