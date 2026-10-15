import { requireApiUser } from "@/lib/auth/current-user";
import { ok, parseBody, route } from "@/lib/http/api";
import { changePassword, changePasswordSchema } from "@/modules/auth/account-flows";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  const user = await requireApiUser("account:self");
  const input = await parseBody(req, changePasswordSchema);
  const { notificationSent } = await changePassword(user, input);
  return ok({ message: "Password changed. All sessions have been signed out; please sign in again.", notificationSent });
});
