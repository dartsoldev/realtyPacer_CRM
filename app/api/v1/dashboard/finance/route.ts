import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { financialCards } from "@/modules/finance/dashboard";

export const runtime = "nodejs";

export const GET = route(async () => {
  const user = await requireApiUser("financials:read");
  return ok(await financialCards(user));
});
