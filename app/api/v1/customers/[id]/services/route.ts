import { z } from "zod";
import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseQuery, route } from "@/lib/http/api";
import { customerServiceLines } from "@/modules/customers/service";

export const runtime = "nodejs";

/** One row per service line: date, service, actual service address, paid toward it (financials:read), cleaners, status. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser("bookings:read");
  const q = parseQuery(req, z.object({ scope: z.enum(["history", "upcoming"]).default("history"), page: z.coerce.number().int().min(1).max(1000).default(1) }));
  return ok(await customerServiceLines(user, (await params).id, q));
});
