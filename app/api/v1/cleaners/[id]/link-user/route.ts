import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, route } from "@/lib/http/api";
import { linkCleanerUser, linkUserSchema } from "@/modules/cleaners/service";

export const runtime = "nodejs";

export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("cleaners:write");
  const { userId } = await parseBody(req, linkUserSchema);
  return ok(await linkCleanerUser(user, (await params).id, userId));
});
