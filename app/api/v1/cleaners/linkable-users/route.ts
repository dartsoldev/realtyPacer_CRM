import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { linkableUsers } from "@/modules/cleaners/service";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("cleaners:write");
  return ok({ items: await linkableUsers(user) });
});
