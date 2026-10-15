import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { customerListQuery } from "@/modules/customers/schemas";
import { createCustomer, listCustomers } from "@/modules/customers/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser("customers:read");
  return ok(await listCustomers(user, parseQuery(req, customerListQuery)));
});

/** 409 POSSIBLE_DUPLICATES (details.matches) unless body.confirmDuplicate is true. Never creates a login account. */
export const POST = route(async (req) => {
  const user = await requireApiUser("customers:write");
  return ok(await createCustomer(user, await readBody(req)), 201);
});
