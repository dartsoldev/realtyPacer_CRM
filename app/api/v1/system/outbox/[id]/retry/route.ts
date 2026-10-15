import { requireApiUser } from "@/lib/auth/current-user";
import { ok, route } from "@/lib/http/api";
import { retryOutboxMessage } from "@/modules/outbox/service";

export const runtime = "nodejs";

export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser("system:diagnostics");
  return ok(await retryOutboxMessage(user, (await params).id));
});
