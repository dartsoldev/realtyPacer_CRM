import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCoreEnv } from "@/lib/env";
import { AppError } from "@/lib/http/errors";
import { GoogleApiError } from "@/lib/integrations/google";
import { logger } from "@/lib/logger";
import { completeGoogleConnect } from "@/modules/integrations/google-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth redirect target registered in Google Cloud. Requires the same signed-in
 * admin who started the flow (state is single-use and bound to that user).
 */
export async function GET(req: Request) {
  const back = (q: string) => NextResponse.redirect(`${getCoreEnv().APP_URL}/dashboard/settings/integrations?${q}`, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return back(`google_error=${encodeURIComponent(error === "access_denied" ? "denied" : "google")}`);
  if (!code || !state) return back("google_error=invalid");
  const user = await getCurrentUser();
  if (!user || !user.permissions.has("integrations:manage")) return back("google_error=signin");
  try {
    await completeGoogleConnect(user, code, state);
    return back("google=connected");
  } catch (err) {
    const codeName = err instanceof AppError ? err.code.toLowerCase() : err instanceof GoogleApiError ? "google" : "unknown";
    logger.warn("integration.google_connect_failed", { code: codeName, error: err instanceof Error ? err.message : String(err) });
    return back(`google_error=${encodeURIComponent(codeName)}`);
  }
}
