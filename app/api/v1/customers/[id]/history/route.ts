import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, route } from "@/lib/http/api";
import { customerHistory } from "@/modules/customers/service";

export const runtime = "nodejs";

export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("bookings:read");
  const q = parseQuery(req, z.object({ page: z.coerce.number().int().min(1).max(1000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }));
  return ok(await customerHistory(user, (await params).id, q.page, q.pageSize));
});
