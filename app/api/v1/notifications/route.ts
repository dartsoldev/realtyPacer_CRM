import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, route } from "@/lib/http/api";
import { listNotifications } from "@/modules/notifications/service";

export const runtime = "nodejs";

/** The caller's own notifications only. */
export const GET = route(async (req) => {
  const user = await requireApiUser();
  const { page } = parseQuery(req, z.object({ page: z.coerce.number().int().min(1).max(100).default(1) }));
  return ok(await listNotifications(user, page));
});
