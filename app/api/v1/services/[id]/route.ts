import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { updateService } from "@/modules/catalog/service";

export const runtime = "nodejs";

/** Catalog edits never change existing bookings (line items are snapshots). */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("services:write");
  return ok(await updateService(user, (await params).id, await readBody(req)));
});
