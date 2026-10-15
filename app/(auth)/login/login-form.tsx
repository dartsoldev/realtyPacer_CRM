"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";

type Values = { email: string; password: string };

export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ defaultValues: { email: "", password: "" } });

  async function onSubmit(values: Values) {
    setError(null);
    const res = await signIn("credentials", { email: values.email, password: values.password, redirect: false, callbackUrl });
    if (res?.ok && !res.error) {
      router.replace(callbackUrl);
      router.refresh();
      return;
    }
    setError(res?.error ?? "Unknown");
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
      {error === "EmailNotVerified" ? (
        <Alert tone="pending" title="Verify your email address first">
          Check your inbox for the verification link, or{" "}
          <Link href="/verify-email" className="font-medium underline">
            request a new one
          </Link>
          .
        </Alert>
      ) : error === "RateLimited" ? (
        <Alert tone="danger" title="Too many sign-in attempts">
          For your security, sign-in is paused for a few minutes. Try again later or reset your password.
        </Alert>
      ) : error === "CredentialsSignin" ? (
        <Alert tone="danger" title="Sign-in failed">
          The email or password is incorrect, or the account is not active.
        </Alert>
      ) : error ? (
        <Alert tone="danger" title="Sign-in is unavailable">
          The server could not complete sign-in. Please try again shortly.
        </Alert>
      ) : null}

      <Field label="Email" error={errors.email?.message}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="email"
            autoComplete="email"
            inputMode="email"
            aria-describedby={describedBy}
            invalid={invalid}
            {...register("email", { required: "Enter your email address.", maxLength: { value: 254, message: "Email is too long." } })}
          />
        )}
      </Field>
      <Field label="Password" error={errors.password?.message}>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="password"
            autoComplete="current-password"
            aria-describedby={describedBy}
            invalid={invalid}
            {...register("password", { required: "Enter your password.", maxLength: { value: 128, message: "Password is too long." } })}
          />
        )}
      </Field>
      <Button type="submit" className="w-full" loading={isSubmitting}>
        Sign in
      </Button>
    </form>
  );
}
