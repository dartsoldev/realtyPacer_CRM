import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, parseQuery, route } from "@/lib/http/api";
import { inviteUser, inviteUserSchema, listUsers, userListQuery } from "@/modules/users/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("users:read");
  return ok(await listUsers(user, parseQuery(req, userListQuery)));
});

export const POST = route(async (req) => {
  const user = await requireApiUser("users:invite");
  const input = await parseBody(req, inviteUserSchema);
  return ok(await inviteUser(user, input), 201);
});
