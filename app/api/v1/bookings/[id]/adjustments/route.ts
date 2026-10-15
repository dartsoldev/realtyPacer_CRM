import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { adjustCharge, listAdjustments } from "@/modules/finance/charges";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("financials:read");
  return ok({ items: await listAdjustments(user, (await params).id) });
});

/** Append-only credit (negative) or extra charge (positive) on a finalized line, with a reason. */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("billing:adjust");
  return ok(await adjustCharge(user, (await params).id, await readBody(req)), 201);
});
