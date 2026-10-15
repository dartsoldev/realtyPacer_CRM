import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, route } from "@/lib/http/api";
import { lookupCustomers } from "@/modules/customers/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("customers:read");
  const { q } = parseQuery(req, z.object({ q: z.string().trim().max(100).default("") }));
  return ok(await lookupCustomers(user, q));
});
