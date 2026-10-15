import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { getSmtpEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { maskEmail } from "@/lib/security/redact";

export type OutgoingEmail = { to: string; subject: string; html: string; text: string };

export class EmailDeliveryError extends Error {
  constructor(readonly code: string) {
    super(`Email delivery failed (${code})`);
    this.name = "EmailDeliveryError";
  }
}

let cached: { key: string; transport: Transporter } | null = null;

function transport(): { transport: Transporter; from: string } {
  const env = getSmtpEnv(); // throws ConfigError if SMTP is not configured
  const key = `${env.SMTP_HOST}:${env.SMTP_PORT}:${env.SMTP_SECURE}:${env.SMTP_USER ?? ""}`;
  if (!cached || cached.key !== key) {
    cached = {
      key,
      transport: nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        // Never downgrade: require TLS when not using implicit TLS, except for
        // plain local development sinks on localhost.
        requireTLS: !env.SMTP_SECURE && !["localhost", "127.0.0.1"].includes(env.SMTP_HOST),
      }),
    };
  }
  return { transport: cached.transport, from: env.EMAIL_FROM };
}

/** Maps transport errors to coarse, non-secret categories. */
function classify(err: unknown): string {
  const e = err as { code?: string; responseCode?: number };
  if (e.code === "EAUTH") return "SMTP_AUTH";
  if (e.code === "ECONNECTION" || e.code === "ECONNREFUSED" || e.code === "ESOCKET" || e.code === "ETIMEDOUT" || e.code === "EDNS")
    return "SMTP_CONNECTION";
  if (e.code === "EENVELOPE") return "SMTP_REJECTED_RECIPIENT";
  if (typeof e.responseCode === "number" && e.responseCode >= 500) return "SMTP_REJECTED";
  if (typeof e.responseCode === "number" && e.responseCode >= 400) return "SMTP_TEMPORARY";
  return "SMTP_UNKNOWN";
}

/**
 * Sends one email. Resolves only when the SMTP server accepted the message;
 * otherwise throws EmailDeliveryError. Acceptance by the relay is *not* proof
 * of inbox delivery — we only ever claim "sent".
 */
export async function sendEmail(message: OutgoingEmail): Promise<{ messageId: string }> {
  const { transport: t, from } = transport();
  try {
    const info = await t.sendMail({ from, to: message.to, subject: message.subject, html: message.html, text: message.text });
    if (Array.isArray(info.rejected) && info.rejected.length > 0) throw Object.assign(new Error("rejected"), { code: "EENVELOPE" });
    logger.info("email.sent", { to: maskEmail(message.to), subject: message.subject });
    return { messageId: String(info.messageId ?? "") };
  } catch (err) {
    const code = classify(err);
    logger.error("email.failed", { to: maskEmail(message.to), subject: message.subject, code });
    throw new EmailDeliveryError(code);
  }
}

/** Test hook: drop the cached transport after env changes. */
export function resetMailerForTests() {
  cached = null;
}
