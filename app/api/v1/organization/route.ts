import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, route } from "@/lib/http/api";
import { getOrganizationSettings, organizationUpdateSchema, updateOrganizationSettings } from "@/modules/organization/service";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("organization:read");
  return ok(await getOrganizationSettings(user));
});

export const PATCH = route(async (req) => {
  const user = await requireApiUser("organization:update");
  const input = await parseBody(req, organizationUpdateSchema);
  return ok(await updateOrganizationSettings(user, input));
});
