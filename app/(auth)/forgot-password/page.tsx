import type { Metadata } from "next";
import Link from "next/link";
import { SetupRequired } from "@/components/setup-required";
import { getConfigStatus } from "@/lib/env";
import { EmailRequestForm } from "../forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  const core = getConfigStatus("core");
  const smtp = getConfigStatus("smtp");
  return (
    <>
      <h1 className="text-xl font-semibold">Reset your password</h1>
      <p className="mt-1 text-sm text-muted">Enter your account email. If it belongs to an active account, we’ll email a reset link valid for 30 minutes.</p>
      <div className="mt-6">
        {!core.ok ? (
          <SetupRequired issues={core.issues} />
        ) : !smtp.ok ? (
          <SetupRequired issues={smtp.issues} service="email (SMTP)" />
        ) : (
          <EmailRequestForm endpoint="/api/v1/auth/forgot-password" submitLabel="Email me a reset link" />
        )}
      </div>
      <p className="mt-6 text-sm">
        <Link href="/login" className="font-medium text-brand underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </>
  );
}
