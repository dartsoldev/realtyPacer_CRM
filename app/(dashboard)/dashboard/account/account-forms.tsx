"use client";

import { signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/domain/constants";

export function ProfileForm({ defaultName }: { defaultName: string }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
    reset,
  } = useForm<{ name: string }>({ defaultValues: { name: defaultName } });

  async function onSubmit(values: { name: string }) {
    setMsg(null);
    const res = await apiRequest<{ name: string }>("/api/v1/account/profile", { method: "PATCH", body: values });
    if (res.ok) {
      setMsg({ tone: "success", text: "Name saved." });
      reset({ name: res.data.name });
      router.refresh();
    } else setMsg({ tone: "danger", text: res.fieldErrors?.name?.[0] ?? res.message });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {msg ? <Alert tone={msg.tone} title={msg.text} /> : null}
      <Field label="Name" error={errors.name?.message}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            autoComplete="name"
            aria-describedby={describedBy}
            invalid={invalid}
            {...register("name", { required: "Name is required.", maxLength: { value: 120, message: "Name is too long." } })}
          />
        )}
      </Field>
      <Button type="submit" variant="secondary" loading={isSubmitting} disabled={!isDirty}>
        Save name
      </Button>
    </form>
  );
}

type PwValues = { currentPassword: string; newPassword: string; confirm: string };

export function ChangePasswordForm() {
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    getValues,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<PwValues>({ defaultValues: { currentPassword: "", newPassword: "", confirm: "" } });

  async function onSubmit(values: PwValues) {
    setError(null);
    const res = await apiRequest<{ message: string; notificationSent: boolean }>("/api/v1/account/password", {
      method: "POST",
      body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
    });
    if (res.ok) {
      // Every session (including this one) was revoked server-side; clear the cookie too.
      await signOut({ callbackUrl: "/login?reason=password_changed" });
      return;
    }
    let handled = false;
    for (const key of ["currentPassword", "newPassword"] as const) {
      const m = res.fieldErrors?.[key]?.[0];
      if (m) {
        setFieldError(key, { message: m });
        handled = true;
      }
    }
    if (!handled) setError(res.message);
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {error ? <Alert tone="danger" title="Password not changed">{error}</Alert> : null}
      <Field label="Current password" error={errors.currentPassword?.message}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} type="password" autoComplete="current-password" aria-describedby={describedBy} invalid={invalid} {...register("currentPassword", { required: "Enter your current password." })} />
        )}
      </Field>
      <Field label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters. A passphrase works well.`} error={errors.newPassword?.message}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            aria-describedby={describedBy}
            invalid={invalid}
            {...register("newPassword", {
              required: "Choose a new password.",
              minLength: { value: PASSWORD_MIN_LENGTH, message: `Use at least ${PASSWORD_MIN_LENGTH} characters.` },
              maxLength: { value: PASSWORD_MAX_LENGTH, message: `Use at most ${PASSWORD_MAX_LENGTH} characters.` },
            })}
          />
        )}
      </Field>
      <Field label="Confirm new password" error={errors.confirm?.message}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            aria-describedby={describedBy}
            invalid={invalid}
            {...register("confirm", { validate: (v) => v === getValues("newPassword") || "Passwords don’t match." })}
          />
        )}
      </Field>
      <Button type="submit" loading={isSubmitting}>
        Change password
      </Button>
    </form>
  );
}
