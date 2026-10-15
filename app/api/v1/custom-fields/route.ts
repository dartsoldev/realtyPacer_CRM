import { requireApiUser } from "@/lib/auth/current-user";
import { z } from "zod";
import { CUSTOM_FIELD_ENTITIES } from "@/lib/domain/constants";
import { ok, parseQuery, readBody, route } from "@/lib/http/api";
import { createDefinition, listDefinitions } from "@/modules/custom-fields/service";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const user = await requireApiUser();
  const q = parseQuery(req, z.object({ entity: z.enum(CUSTOM_FIELD_ENTITIES).optional(), archived: z.enum(["1"]).optional() }));
  return ok({ items: await listDefinitions(user, q.entity, q.archived === "1") });
});

/** Keys are generated server-side; clients can never choose a storage path. */
export const POST = route(async (req) => {
  const user = await requireApiUser("customFields:manage");
  return ok(await createDefinition(user, await readBody(req)), 201);
});
