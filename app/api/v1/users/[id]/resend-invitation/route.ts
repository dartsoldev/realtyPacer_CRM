import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { resendInvitation } from "@/modules/users/service";

export const runtime = "nodejs";

export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("users:invite");
  const { id } = await params;
  return ok(await resendInvitation(user, id));
});
