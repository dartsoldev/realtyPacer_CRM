import { ok, parseBody, route } from "@/lib/http/api";
import { emailOnlySchema, resendVerification } from "@/modules/auth/account-flows";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  const { email } = await parseBody(req, emailOnlySchema);
  await resendVerification(email, req.headers);
  return ok({ message: "If that address belongs to an account awaiting verification, a new link is on its way." });
});
