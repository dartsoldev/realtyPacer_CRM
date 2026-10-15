import type { Metadata } from "next";
import { SetupRequired } from "@/components/setup-required";
import { hashToken, inspectToken, isWellFormedToken } from "@/lib/auth/tokens";
import { connectDb } from "@/lib/db/connect";
import { AuthToken } from "@/lib/db/models/auth-token";
import { Organization } from "@/lib/db/models/organization";
import { User } from "@/lib/db/models/user";
import { getConfigStatus } from "@/lib/env";
import { NewPasswordForm } from "../forms";
import { TokenProblem } from "../token-state";

export const metadata: Metadata = { title: "Accept invitation", referrer: "no-referrer" };

async function invitationContext(token: string) {
  if (!isWellFormedToken(token)) return null;
  await connectDb();
  const t = await AuthToken.findOne({ tokenHash: hashToken(token), purpose: "invitation" }).select("userId organizationId").lean();
  if (!t) return null;
  const [user, org] = await Promise.all([
    User.findById(t.userId).select("name email status").lean(),
    Organization.findById(t.organizationId).select("displayName").lean(),
  ]);
  if (!user || user.status !== "invited") return null;
  return { name: user.name, email: user.email, orgName: org?.displayName ?? "your organization" };
}

export default async function AcceptInvitationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  const core = getConfigStatus("core");
  if (!core.ok) return <SetupRequired issues={core.issues} />;

  let state = await inspectToken(token, "invitation");
  const ctx = state === "valid" ? await invitationContext(token) : null;
  if (state === "valid" && !ctx) state = "invalid";

  return (
    <>
      <h1 className="text-xl font-semibold">{ctx ? `Join ${ctx.orgName}` : "Accept invitation"}</h1>
      {ctx ? (
        <>
          <p className="mt-1 mb-6 text-sm text-muted">
            Set a password for <span className="font-medium text-ink">{ctx.email}</span> to activate your account.
          </p>
          <NewPasswordForm endpoint="/api/v1/auth/accept-invitation" token={token} submitLabel="Activate account" askName defaultName={ctx.name} />
        </>
      ) : (
        <div className="mt-6">
          <TokenProblem
            state={state === "valid" ? "invalid" : state}
            what="invitation link"
            retryHref="/login"
            retryLabel="Go to sign in"
          />
          <p className="mt-4 text-sm text-muted">Ask your administrator to resend your invitation.</p>
        </div>
      )}
    </>
  );
}
