import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { previewImport } from "@/modules/imports/customers";

export const runtime = "nodejs";

/** { mapping: { "<column index>": "<target field>" } } → validation + duplicate candidates. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("customers:import");
  return ok(await previewImport(user, (await params).id, await readBody(req)));
});
