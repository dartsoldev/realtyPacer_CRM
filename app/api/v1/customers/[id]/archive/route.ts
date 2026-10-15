import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, route } from "@/lib/http/api";
import { setCustomerArchived } from "@/modules/customers/service";

export const runtime = "nodejs";

export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("customers:write");
  const { archived } = await parseBody(req, z.object({ archived: z.boolean() }).strict());
  return ok(await setCustomerArchived(user, (await params).id, archived));
});
