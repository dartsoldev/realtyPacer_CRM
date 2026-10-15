import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, route } from "@/lib/http/api";
import { markBrowserCallFailed } from "@/modules/calls/service";

export const runtime = "nodejs";

/** The browser could not start the call (e.g. microphone blocked) before the provider connected. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("calls:browser");
  const { reason } = await parseBody(req, z.object({ reason: z.string().trim().min(1).max(200) }).strict());
  return ok(await markBrowserCallFailed(user, (await params).id, reason));
});
