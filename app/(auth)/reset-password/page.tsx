import type { Metadata } from "next";
import { SetupRequired } from "@/components/setup-required";
import { inspectToken } from "@/lib/auth/tokens";
import { getConfigStatus } from "@/lib/env";
import { NewPasswordForm } from "../forms";
import { TokenProblem } from "../token-state";

export const metadata: Metadata = { title: "Choose a new password", referrer: "no-referrer" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const core = getConfigStatus("core");
  if (!core.ok) return <SetupRequired issues={core.issues} />;
  const state = await inspectToken(token, "password_reset");
  return (
    <>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <p className="mt-1 mb-6 text-sm text-muted">Setting a new password signs you out everywhere else.</p>
      {state === "valid" ? (
        <NewPasswordForm endpoint="/api/v1/auth/reset-password" token={token} submitLabel="Save new password" />
      ) : (
        <TokenProblem state={state} what="reset link" retryHref="/forgot-password" retryLabel="Request a new reset link" />
      )}
    </>
  );
}
