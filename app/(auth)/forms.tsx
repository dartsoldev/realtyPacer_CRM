"use client";

import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { apiRequest } from "@/lib/client/api";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/domain/constants";

/** Email-only request form (forgot password / resend verification). Always shows the server's generic message. */
export function EmailRequestForm({ endpoint, submitLabel }: { endpoint: string; submitLabel: string }) {
  const [result, setResult] = useState<{ tone: "success" | "danger"; title: string; body?: string } | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<{ email: string }>({ defaultValues: { email: "" } });

  async function onSubmit(values: { email: string }) {
    setResult(null);
    const res = await apiRequest<{ message: string }>(endpoint, { method: "POST", body: values });
    if (res.ok) setResult({ tone: "success", title: "Check your inbox", body: res.data.message });
    else if (res.code === "RATE_LIMITED") setResult({ tone: "danger", title: "Too many requests", body: "Please wait a while before trying again." });
    else if (res.code === "SETUP_REQUIRED") setResult({ tone: "danger", title: "Email is not configured", body: "No email was sent. An administrator must configure SMTP." });
    else setResult({ tone: "danger", title: "Request failed", body: res.fieldErrors?.email?.[0] ?? res.message });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {result ? (
        <Alert tone={result.tone} title={result.title}>
          {result.body}
        </Alert>
      ) : null}
      <Field label="Email" error={errors.email?.message}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="email"
            autoComplete="email"
            aria-describedby={describedBy}
            invalid={invalid}
            {...register("email", { required: "Enter your email address.", maxLength: { value: 254, message: "Email is too long." } })}
          />
        )}
      </Field>
      <Button type="submit" className="w-full" loading={isSubmitting}>
        {submitLabel}
      </Button>
    </form>
  );
}

type PasswordValues = { name?: string; password: string; confirm: string };

/** New-password form used by invitation acceptance and password reset. */
export function NewPasswordForm({
  endpoint,
  token,
  submitLabel,
  askName,
  defaultName,
}: {
  endpoint: string;
  token: string;
  submitLabel: string;
  askName?: boolean;
  defaultName?: string;
}) {
  const [done, setDone] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ title: string; body: string; terminal: boolean } | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<PasswordValues>({ defaultValues: { name: defaultName ?? "", password: "", confirm: "" } });

  async function onSubmit(values: PasswordValues) {
    setFailure(null);
    const body: Record<string, string> = { token, password: values.password };
    if (askName && values.name) body.name = values.name;
    const res = await apiRequest<{ message: string }>(endpoint, { method: "POST", body });
    if (res.ok) {
      setDone(res.data.message);
      return;
    }
    if (res.fieldErrors?.password?.[0]) {
      setError("password", { message: res.fieldErrors.password[0] });
      return;
    }
    const terminal = ["TOKEN_EXPIRED", "TOKEN_USED", "TOKEN_INVALID"].includes(res.code);
    setFailure({ title: terminal ? "This link can’t be used" : "Something went wrong", body: res.message, terminal });
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Alert tone="success" title="All set">
          {done}
        </Alert>
        <Link href="/login" className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {failure ? (
        <Alert tone="danger" title={failure.title}>
          {failure.body}
        </Alert>
      ) : null}
      {askName ? (
        <Field label="Your name" error={errors.name?.message}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} autoComplete="name" aria-describedby={describedBy} invalid={invalid} {...register("name", { maxLength: { value: 120, message: "Name is too long." } })} />
          )}
        </Field>
      ) : null}
      <Field
        label="New password"
        required
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. A memorable passphrase of several words is ideal.`}
        error={errors.password?.message}
      >
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            aria-describedby={describedBy}
            invalid={invalid}
            {...register("password", {
              required: "Choose a password.",
              minLength: { value: PASSWORD_MIN_LENGTH, message: `Use at least ${PASSWORD_MIN_LENGTH} characters.` },
              maxLength: { value: PASSWORD_MAX_LENGTH, message: `Use at most ${PASSWORD_MAX_LENGTH} characters.` },
            })}
          />
        )}
      </Field>
      <Field label="Confirm new password" required error={errors.confirm?.message}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            aria-describedby={describedBy}
            invalid={invalid}
            {...register("confirm", { validate: (v) => v === getValues("password") || "Passwords don’t match." })}
          />
        )}
      </Field>
      <Button type="submit" className="w-full" loading={isSubmitting} disabled={failure?.terminal}>
        {submitLabel}
      </Button>
    </form>
  );
}

/** Explicit button so email link scanners (GET prefetch) can't consume verification tokens. */
export function VerifyEmailButton({ token }: { token: string }) {
  const [state, setState] = useState<{ tone: "success" | "danger"; title: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    setBusy(true);
    const res = await apiRequest<{ message: string }>("/api/v1/auth/verify-email", { method: "POST", body: { token } });
    setBusy(false);
    setState(res.ok ? { tone: "success", title: "Email verified", body: res.data.message } : { tone: "danger", title: "Verification failed", body: res.message });
  }

  if (state?.tone === "success") {
    return (
      <div className="space-y-4">
        <Alert tone="success" title={state.title}>
          {state.body}
        </Alert>
        <Link href="/login" className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover">
          Go to sign in
        </Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {state ? (
        <Alert tone="danger" title={state.title}>
          {state.body}
        </Alert>
      ) : null}
      <Button type="button" className="w-full" onClick={verify} loading={busy}>
        Verify my email address
      </Button>
    </div>
  );
}
