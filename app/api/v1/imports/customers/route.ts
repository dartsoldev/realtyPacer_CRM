import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { uploadImport } from "@/modules/imports/customers";

export const runtime = "nodejs";

/** { fileName, csv } (≤ 2 MB, ≤ 5,000 rows). Nothing is written to customers until "run". */
export const POST = route(async (req) => {
  const user = await requireApiUser("customers:import");
  // JSON-escaped CSV of up to 2 MB; the service enforces the 2 MB file limit itself.
  return ok(await uploadImport(user, await readBody(req, 3 * 1024 * 1024)), 201);
});
