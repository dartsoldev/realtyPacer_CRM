import type { Metadata } from "next";
import { RoleBadge } from "@/components/ui/badge";
import { Card, CardHeader, PageHeader } from "@/components/ui/layout";
import { requirePageUser } from "@/lib/auth/page-guard";
import { ChangePasswordForm, ProfileForm } from "./account-forms";

export const metadata: Metadata = { title: "Your account" };

export default async function AccountPage() {
  const user = await requirePageUser("/dashboard/account");
  return (
    <>
      <PageHeader title="Your account" description="Manage your name and password." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" />
          <div className="space-y-4 p-5">
            <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted">Email</dt>
              <dd className="break-all">{user.email}</dd>
              <dt className="text-muted">Role</dt>
              <dd>
                <RoleBadge role={user.role} />
              </dd>
              <dt className="text-muted">Organization</dt>
              <dd>{user.organization.displayName}</dd>
            </dl>
            <ProfileForm defaultName={user.name} />
          </div>
        </Card>
        <Card>
          <CardHeader title="Change password" description="Changing your password signs you out on every device, including this one." />
          <div className="p-5">
            <ChangePasswordForm />
          </div>
        </Card>
      </div>
    </>
  );
}
