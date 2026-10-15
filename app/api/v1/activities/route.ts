import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, parseQuery, route } from "@/lib/http/api";
import { activityListQuery, addNote, createNoteSchema, listActivities } from "@/modules/activities/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser();
  return ok(await listActivities(user, parseQuery(req, activityListQuery)));
});

/** Manual note or call outcome (a tel: link click is never logged automatically). */
export const POST = route(async (req) => {
  const user = await requireApiUser("activities:write");
  return ok(await addNote(user, await parseBody(req, createNoteSchema)), 201);
});
