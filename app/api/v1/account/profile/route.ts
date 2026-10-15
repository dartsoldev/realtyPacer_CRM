import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, route } from "@/lib/http/api";
import { updateOwnProfile, updateProfileSchema } from "@/modules/users/service";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("account:self");
  return ok({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: [...user.permissions],
    organization: { id: user.organization.id, displayName: user.organization.displayName, timezone: user.organization.timezone },
  });
});

export const PATCH = route(async (req) => {
  const user = await requireApiUser("account:self");
  const input = await parseBody(req, updateProfileSchema);
  return ok(await updateOwnProfile(user, input));
});
