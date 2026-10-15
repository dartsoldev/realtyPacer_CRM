import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SetupRequired } from "@/components/setup-required";
import { Alert } from "@/components/ui/alert";
import { checkSession } from "@/lib/auth/current-user";
import { getConfigStatus } from "@/lib/env";
import { safeCallbackPath } from "@/lib/site";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const callbackUrl = safeCallbackPath(typeof sp.callbackUrl === "string" ? sp.callbackUrl : null);
  const reason = typeof sp.reason === "string" ? sp.reason : null;

  const config = getConfigStatus("core");
  if (!config.ok) {
    return (
      <>
        <h1 className="mb-4 text-xl font-semibold">Sign in</h1>
        <SetupRequired issues={config.issues} />
      </>
    );
  }

  // Already signed in with a *valid* session → go straight to the app.
  const session = await checkSession();
  if (session.user) redirect(callbackUrl);

  return (
    <>
      <h1 className="text-xl font-semibold">Sign in to RealtyPacer</h1>
      <p className="mt-1 text-sm text-muted">Use the email address your administrator invited.</p>
      <div className="mt-6 space-y-4">
        {reason === "session_ended" ? (
          <Alert tone="info" title="Your session ended">
            Your access changed or you signed in elsewhere with a new password. Please sign in again.
          </Alert>
        ) : null}
        {reason === "signed_out" ? <Alert tone="success" title="You have been signed out" /> : null}
        {reason === "password_changed" ? (
          <Alert tone="success" title="Password updated">
            Sign in with your new password.
          </Alert>
        ) : null}
        <LoginForm callbackUrl={callbackUrl} />
      </div>
      <div className="mt-6 flex flex-col gap-2 text-sm">
        <Link href="/forgot-password" className="font-medium text-brand underline-offset-4 hover:underline">
          Forgot your password?
        </Link>
        <Link href="/verify-email" className="text-muted underline-offset-4 hover:underline">
          Need a new verification email?
        </Link>
      </div>
    </>
  );
}
