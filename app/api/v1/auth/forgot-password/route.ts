import { ok, parseBody, route } from "@/lib/http/api";
import { emailOnlySchema, requestPasswordReset } from "@/modules/auth/account-flows";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  const { email } = await parseBody(req, emailOnlySchema);
  await requestPasswordReset(email, req.headers);
  return ok({ message: "If an active account uses that address, a reset link is on its way. The link expires in 30 minutes." });
});
