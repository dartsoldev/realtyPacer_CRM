import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { updateCall } from "@/modules/calls/service";

export const runtime = "nodejs";

/** Edit notes / refine the outcome of a call you made. */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("calls:log");
  return ok(await updateCall(user, (await params).id, await readBody(req)));
});
