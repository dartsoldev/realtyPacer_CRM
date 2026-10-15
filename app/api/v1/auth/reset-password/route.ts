import { ok, parseBody, route } from "@/lib/http/api";
import { resetPassword, tokenPasswordSchema } from "@/modules/auth/account-flows";
import { tokenFailure } from "../token-errors";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  const input = await parseBody(req, tokenPasswordSchema);
  const result = await resetPassword(input, req.headers);
  if (!result.ok) throw tokenFailure(result.reason, "reset link");
  return ok({ message: "Your password has been reset. Sign in with your new password." });
});
