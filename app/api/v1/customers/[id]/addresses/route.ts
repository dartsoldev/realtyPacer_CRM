import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, parseQuery, route } from "@/lib/http/api";
import { createAddress, listAddresses } from "@/modules/customers/addresses";
import { addressInputSchema } from "@/modules/customers/schemas";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("customers:read");
  const { archived } = parseQuery(req, z.object({ archived: z.enum(["1"]).optional() }));
  return ok({ items: await listAddresses(user, (await params).id, archived === "1") });
});

export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("customers:write");
  const input = await parseBody(req, addressInputSchema);
  return ok(await createAddress(user, (await params).id, input), 201);
});
