import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { inviteCleaner } from "@/modules/cleaners/service";

export const runtime = "nodejs";

/** Explicit invitation using the existing invitation flow (role CLEANER). */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("users:invite");
  return ok(await inviteCleaner(user, (await params).id));
});
