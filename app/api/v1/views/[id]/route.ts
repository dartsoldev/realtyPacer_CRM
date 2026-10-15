import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { deleteView, updateView } from "@/modules/reports/views";

export const runtime = "nodejs";

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("reports:read");
  return ok(await updateView(user, (await params).id, await readBody(req)));
});

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("reports:read");
  return ok(await deleteView(user, (await params).id));
});
