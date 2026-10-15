import type { Metadata } from "next";
import Link from "next/link";
import { SetupRequired } from "@/components/setup-required";
import { inspectToken } from "@/lib/auth/tokens";
import { getConfigStatus } from "@/lib/env";
import { EmailRequestForm, VerifyEmailButton } from "../forms";
import { TokenProblem } from "../token-state";

export const metadata: Metadata = { title: "Verify email", referrer: "no-referrer" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const core = getConfigStatus("core");
  if (!core.ok) return <SetupRequired issues={core.issues} />;

  if (token) {
    const state = await inspectToken(token, "email_verification");
    return (
      <>
        <h1 className="mb-6 text-xl font-semibold">Verify your email address</h1>
        {state === "valid" ? (
          <VerifyEmailButton token={token} />
        ) : (
          <TokenProblem state={state} what="verification link" retryHref="/verify-email" retryLabel="Request a new verification email" />
        )}
      </>
    );
  }

  const smtp = getConfigStatus("smtp");
  return (
    <>
      <h1 className="text-xl font-semibold">Resend verification email</h1>
      <p className="mt-1 mb-6 text-sm text-muted">Enter your account email. If it’s waiting for verification, we’ll send a new link valid for 24 hours.</p>
      {smtp.ok ? (
        <EmailRequestForm endpoint="/api/v1/auth/resend-verification" submitLabel="Send verification email" />
      ) : (
        <SetupRequired issues={smtp.issues} service="email (SMTP)" />
      )}
      <p className="mt-6 text-sm">
        <Link href="/login" className="font-medium text-brand underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
