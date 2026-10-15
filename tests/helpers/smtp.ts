import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { resetMailerForTests } from "@/lib/email/mailer";

export type CapturedMail = { to: string[]; raw: string };

/**
 * Local SMTP server for tests. `mode: "reject"` answers every message with a
 * permanent 550 failure to exercise delivery-failure handling.
 */
export async function startSmtp(mode: "accept" | "reject" = "accept") {
  const messages: CapturedMail[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        if (mode === "reject") {
          const err = Object.assign(new Error("Mailbox unavailable"), { responseCode: 550 });
          return callback(err);
        }
        messages.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString("utf8") });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_SECURE = "false";
  process.env.EMAIL_FROM = "RealtyPacer Test <test@localhost>";
  resetMailerForTests();
  return {
    messages,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "EMAIL_FROM"]) delete process.env[k];
      resetMailerForTests();
    },
  };
}

/** Extracts the one-time token from a captured email (handles quoted-printable soft breaks). */
export function tokenFromMail(mail: CapturedMail, path: string): string {
  const unfolded = mail.raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  const m = unfolded.match(new RegExp(`${path.replace("/", "\\/")}\\?token=([A-Za-z0-9_-]{43})`));
  if (!m?.[1]) throw new Error("token not found in email");
  return m[1];
}
