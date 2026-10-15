/**
 * Creates the FIRST superadmin. Server-side only; there is no HTTP route for this.
 *
 *   npm run bootstrap:superadmin -- --name "Jane Owner" [--email owner@example.com]
 *       [--org-name "My Cleaning Co"] [--mode invite|password] [--send-email]
 *
 * --mode invite (default): creates an invited superadmin and prints a one-time
 *   setup link (72h) to this terminal. With --send-email it is also emailed.
 * --mode password: prompts for a password with hidden input (twice). Use only
 *   when you are the account owner; the email is marked operator-attested.
 *
 * Refuses to run when any superadmin already exists, and never elevates an
 * existing account. No default password exists anywhere.
 */
import "./_env";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { Organization } from "@/lib/db/models/organization";
import { User } from "@/lib/db/models/user";
import { contextualPasswordProblem, hashPassword, passwordSchema } from "@/lib/auth/password";
import { issueToken, recordDelivery, TOKEN_TTL_MS } from "@/lib/auth/tokens";
import { normalizeEmail } from "@/lib/domain/normalize";
import { sendEmail } from "@/lib/email/mailer";
import { invitationEmail } from "@/lib/email/templates";
import { recordAudit } from "@/modules/audit/service";
import { appLink } from "@/modules/auth/links";

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Reads a line from the TTY without echoing it. */
function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) fail("Password mode needs an interactive terminal. Use --mode invite instead.");
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function askVisible(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      "org-name": { type: "string" },
      mode: { type: "string" },
      "send-email": { type: "boolean" },
    },
    allowPositionals: true,
  });
  // PowerShell drops a bare `--`, so `npm run bootstrap:superadmin -- --name …`
  // reaches npm without it: npm then consumes --name/--email itself and exposes
  // them as npm_config_* variables. Recover those, and accept a bare email too.
  const npmConfig = (key: string) => process.env[`npm_config_${key}`]?.trim() || undefined;
  const positionalEmail = positionals.find((p) => p.includes("@"));
  const positionalName = positionals.filter((p) => !p.includes("@")).join(" ").trim() || undefined;

  const isEmail = (v: string | undefined): v is string => Boolean(v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  // npm may turn `--email` into the flag "true" and pass the address positionally.
  const rawEmail = [values.email, npmConfig("email"), positionalEmail, process.env.SUPERADMIN_EMAIL].find(isEmail);
  if (!rawEmail) fail("Provide --email or set SUPERADMIN_EMAIL to a valid address.");
  const npmName = npmConfig("name");
  let name = values.name?.trim() || (npmName && npmName !== "true" ? npmName : undefined) || positionalName;
  if (!name && process.stdin.isTTY) name = (await askVisible("Full name for the superadmin: ")).trim();
  if (!name) fail('Provide --name "Full Name".');
  const mode = values.mode ?? npmConfig("mode") ?? "invite";
  values["org-name"] ??= npmConfig("org_name");
  values["send-email"] ??= npmConfig("send_email") === "true";
  if (mode !== "invite" && mode !== "password") fail("--mode must be 'invite' or 'password'.");
  const email = normalizeEmail(rawEmail);

  await connectDb();

  if (await User.exists({ role: "SUPERADMIN" })) {
    fail("A superadmin already exists. Bootstrap can only be used once; manage users from the app.");
  }
  if (await User.exists({ email })) {
    fail("An account with that email already exists. Bootstrap never elevates existing accounts.");
  }

  const orgCount = await Organization.countDocuments();
  if (orgCount > 1) fail("More than one organization exists; bootstrap expects zero or one.");
  let org = await Organization.findOne();
  if (!org) {
    const orgName = values["org-name"]?.trim() || "RealtyPacer";
    org = await Organization.create({ name: orgName, displayName: orgName });
    console.log(`✔ Created organization "${orgName}" (timezone America/Toronto, currency CAD — editable in the app).`);
  }

  if (mode === "password") {
    const password = await readHidden("Choose a password (hidden): ");
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success) fail(parsed.error.issues[0]?.message ?? "Invalid password.");
    const problem = contextualPasswordProblem(password, { email, name });
    if (problem) fail(problem);
    const confirm = await readHidden("Confirm password (hidden): ");
    if (confirm !== password) fail("Passwords do not match.");
    const user = await User.create({
      organizationId: org._id,
      email,
      name,
      role: "SUPERADMIN",
      status: "active",
      passwordHash: await hashPassword(password),
      passwordChangedAt: new Date(),
      emailVerifiedAt: new Date(),
    });
    await recordAudit({
      organizationId: org._id,
      actorId: null,
      action: "bootstrap.superadmin_created",
      entityType: "user",
      entityId: user._id,
      metadata: { mode: "password", verification: "cli_operator_attested" },
    });
    console.log(`\n✔ Superadmin created and active. Sign in at ${appLink("/login")}\n`);
    return;
  }

  const user = await User.create({ organizationId: org._id, email, name, role: "SUPERADMIN", status: "invited" });
  const issued = await issueToken({ userId: user._id, organizationId: org._id, purpose: "invitation" });
  const url = appLink("/accept-invitation", { token: issued.raw });
  let emailed = false;
  if (values["send-email"]) {
    try {
      await sendEmail(
        invitationEmail({ to: email, inviteeName: name, inviterName: "RealtyPacer setup", orgName: org.displayName, url, expiresHours: TOKEN_TTL_MS.invitation / 3_600_000 }),
      );
      await recordDelivery(issued.tokenId, { ok: true });
      emailed = true;
    } catch (err) {
      await recordDelivery(issued.tokenId, { ok: false, code: (err as { code?: string }).code ?? "UNKNOWN" });
      console.error("⚠ The invitation email could not be sent (nothing was delivered). Use the link below instead.");
    }
  } else {
    await recordDelivery(issued.tokenId, { ok: false, code: "NOT_SENT_CLI" });
  }
  await recordAudit({
    organizationId: org._id,
    actorId: null,
    action: "bootstrap.superadmin_created",
    entityType: "user",
    entityId: user._id,
    metadata: { mode: "invite", emailSent: emailed },
  });
  console.log("\n✔ Superadmin invitation created.");
  if (emailed) console.log("  The SMTP server accepted the invitation email.");
  console.log("\n  One-time setup link (valid 72 hours, single use — treat it like a password):\n");
  console.log(`  ${url}\n`);
}

main()
  .catch((err) => {
    console.error("✖ Bootstrap failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
