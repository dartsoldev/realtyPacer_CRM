import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { deleteAttachment } from "@/modules/attachments/service";

export const runtime = "nodejs";

export const DELETE = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await deleteAttachment(user, (await params).id));
});
