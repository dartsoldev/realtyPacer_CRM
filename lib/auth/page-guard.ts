import "server-only";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { checkSession, type CurrentUser } from "./current-user";

/**
 * For server-rendered pages: returns the validated user or redirects to the
 * login page. Every protected page calls this itself — a layout check alone
 * is not relied on for authorization.
 */
export async function requirePageUser(callbackPath: string): Promise<CurrentUser> {
  await connection(); // opt out of static rendering even if a segment forgets to
  const check = await checkSession();
  if (!check.user) {
    const params = new URLSearchParams({ callbackUrl: callbackPath });
    if (check.reason === "revoked") params.set("reason", "session_ended");
    redirect(`/login?${params.toString()}`);
  }
  return check.user;
}
