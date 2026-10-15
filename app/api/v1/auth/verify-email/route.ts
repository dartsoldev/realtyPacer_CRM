import { ok, parseBody, route } from "@/lib/http/api";
import { tokenSchema, verifyEmail } from "@/modules/auth/account-flows";
import { tokenFailure } from "../token-errors";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  const { token } = await parseBody(req, tokenSchema);
  const result = await verifyEmail(token, req.headers);
  if (!result.ok) throw tokenFailure(result.reason, "verification link");
  return ok({ message: "Your email address is verified. You can now sign in." });
});
