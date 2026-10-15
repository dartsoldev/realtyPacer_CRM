import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { getCustomer, updateCustomer } from "@/modules/customers/service";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("customers:read");
  return ok(await getCustomer(user, (await params).id));
});

export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("customers:write");
  return ok(await updateCustomer(user, (await params).id, await readBody(req)));
});
