import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { conversionMatches } from "@/modules/leads/service";

export const runtime = "nodejs";

/** Existing customers with the same phone, email or name (for Convert to customer). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("leads:read");
  return ok({ items: await conversionMatches(user, (await params).id) });
});
