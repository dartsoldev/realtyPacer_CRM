import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, route } from "@/lib/http/api";
import { setCleanerState } from "@/modules/cleaners/service";

export const runtime = "nodejs";

/** Returns affectedBookings (future assignments are kept for explicit reassignment). */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("cleaners:write");
  const { state } = await parseBody(req, z.object({ state: z.enum(["active", "inactive", "archived"]) }).strict());
  return ok(await setCleanerState(user, (await params).id, state));
});
