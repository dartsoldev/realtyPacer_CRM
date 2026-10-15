import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { listAttachments } from "@/modules/attachments/service";

export const runtime = "nodejs";

/** ?parentType=address|booking&parentId=… — access is checked against the parent record. */
export const GET = route(async (req) => {
  const user = await requireApiUser();
  const url = new URL(req.url);
  return ok({ items: await listAttachments(user, { parentType: url.searchParams.get("parentType"), parentId: url.searchParams.get("parentId"), ...(url.searchParams.get("includeProperty") === "1" ? { includeProperty: "1" } : {}) }) });
});
