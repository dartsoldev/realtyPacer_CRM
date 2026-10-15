import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { runImportBatch } from "@/modules/imports/customers";

export const runtime = "nodejs";

/** Processes the next batch (100 rows). Call until status is "completed"; safe to retry. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("customers:import");
  return ok(await runImportBatch(user, (await params).id));
});
