import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { getCleaner, updateCleaner } from "@/modules/cleaners/service";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("cleaners:read");
  return ok(await getCleaner(user, (await params).id));
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("cleaners:write");
  return ok(await updateCleaner(user, (await params).id, await readBody(req)));
});
