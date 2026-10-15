import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, route } from "@/lib/http/api";
import { updateUser, updateUserSchema } from "@/modules/users/service";

export const runtime = "nodejs";

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("users:manage");
  const { id } = await params;
  const input = await parseBody(req, updateUserSchema);
  return ok(await updateUser(user, id, input));
});
