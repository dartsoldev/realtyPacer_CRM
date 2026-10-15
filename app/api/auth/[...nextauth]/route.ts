import NextAuth from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";
import { errorResponse } from "@/lib/http/api";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ nextauth: string[] }> };

async function handler(req: Request, ctx: Ctx) {
  let options;
  try {
    options = getAuthOptions();
  } catch (err) {
    return errorResponse(err);
  }
  // v4's route-handler form: NextAuth(req, context, options); it awaits context.params itself.
  return NextAuth(req as never, ctx as never, options);
}

export { handler as GET, handler as POST };
