import { ok, parseBody, route } from "@/lib/http/api";
import { acceptInvitation, acceptInvitationSchema } from "@/modules/auth/account-flows";
import { tokenFailure } from "../token-errors";

export const runtime = "nodejs";

export const POST = route(async (req) => {
  const input = await parseBody(req, acceptInvitationSchema);
  const result = await acceptInvitation(input, req.headers);
  if (!result.ok) throw tokenFailure(result.reason, "invitation link");
  return ok({ message: "Your account is ready. Sign in with your new password." });
});
