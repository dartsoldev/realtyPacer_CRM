import { requireApiUser } from "@/lib/auth/current-user";
import { ok, readBody, route } from "@/lib/http/api";
import { updateCustomerCustomFields } from "@/modules/customers/service";

export const runtime = "nodejs";

/** { customFields: { <key>: value | null } } — validated against the definitions; other customer fields untouched. */
export const PATCH = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("customers:write");
  return ok(await updateCustomerCustomFields(user, (await params).id, await readBody(req)));
});
