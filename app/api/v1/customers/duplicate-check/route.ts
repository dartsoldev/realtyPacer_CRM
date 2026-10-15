import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { checkDuplicates } from "@/modules/customers/service";

export const runtime = "nodejs";

/** POST so names/phones/emails stay out of URLs and logs. */
export const POST = route(async (req) => {
  const user = await requireApiUser("customers:read");
  return ok(await checkDuplicates(user, await readBody(req)));
});
