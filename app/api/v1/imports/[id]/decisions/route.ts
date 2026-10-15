import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { decideRows } from "@/modules/imports/customers";

export const runtime = "nodejs";

/** Explicit create / skip / update (with chosen fields to overwrite) per row. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("customers:import");
  return ok(await decideRows(user, (await params).id, await readBody(req, 1024 * 1024)));
});
