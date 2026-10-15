import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { updateDefinition } from "@/modules/custom-fields/service";

export const runtime = "nodejs";

/** Rename/options/flags/archive. Type changes are refused while values exist (409 TYPE_CHANGE_BLOCKED). */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("customFields:manage");
  return ok(await updateDefinition(user, (await params).id, await readBody(req)));
});
