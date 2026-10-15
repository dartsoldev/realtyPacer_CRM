import "server-only";
import { z } from "zod";

/**
 * Server configuration. Parsed lazily at runtime (never at build time) so a
 * build can succeed without secrets, while every request that needs a service
 * fails loudly with a setup error instead of pretending to work.
 *
 * Error messages name missing/invalid variables but never echo their values.
 */
export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Server configuration is incomplete: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const boolString = z
  .enum(["true", "false", ""])
  .optional()
  .transform((v) => v === "true");

const coreSchema = z.object({
  MONGODB_URI: z
    .string({ error: "MONGODB_URI is required" })
    .min(1, "MONGODB_URI is required")
    .refine((v) => /^mongodb(\+srv)?:\/\//.test(v), "MONGODB_URI must start with mongodb:// or mongodb+srv://")
    .refine((v) => !v.includes("<USERNAME>") && !v.includes("<PASSWORD>"), "MONGODB_URI still contains placeholders"),
  APP_URL: z
    .string({ error: "APP_URL is required" })
    .url("APP_URL must be an absolute URL")
    .transform((v) => new URL(v).origin),
  NEXTAUTH_SECRET: z
    .string({ error: "NEXTAUTH_SECRET is required" })
    .min(32, "NEXTAUTH_SECRET must be at least 32 characters"),
  NEXTAUTH_URL: z.string().url("NEXTAUTH_URL must be an absolute URL").optional(),
  TRUST_PROXY_HEADERS: boolString,
});

const smtpSchema = z.object({
  SMTP_HOST: z.string().min(1, "SMTP_HOST is required"),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_SECURE: boolString,
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().min(3, "EMAIL_FROM is required"),
});

export type CoreEnv = z.infer<typeof coreSchema>;
export type SmtpEnv = z.infer<typeof smtpSchema>;

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const key = i.path.join(".") || "env";
    // Zod's default "expected string, received undefined" leaks nothing, but
    // a friendlier message is clearer for operators.
    return i.message.startsWith(key) ? i.message : `${key}: ${i.message}`;
  });
}

function blankToUndefined(v: string | undefined) {
  return v === undefined || v.trim() === "" ? undefined : v;
}

export function getCoreEnv(): CoreEnv {
  const parsed = coreSchema.safeParse({
    MONGODB_URI: blankToUndefined(process.env.MONGODB_URI),
    APP_URL: blankToUndefined(process.env.APP_URL),
    NEXTAUTH_SECRET: blankToUndefined(process.env.NEXTAUTH_SECRET),
    NEXTAUTH_URL: blankToUndefined(process.env.NEXTAUTH_URL),
    TRUST_PROXY_HEADERS: blankToUndefined(process.env.TRUST_PROXY_HEADERS),
  });
  if (!parsed.success) throw new ConfigError(issuesOf(parsed.error));
  const env = parsed.data;
  if (env.NEXTAUTH_URL && new URL(env.NEXTAUTH_URL).origin !== env.APP_URL) {
    throw new ConfigError(["NEXTAUTH_URL must have the same origin as APP_URL"]);
  }
  return env;
}

export function getSmtpEnv(): SmtpEnv {
  const parsed = smtpSchema.safeParse({
    SMTP_HOST: blankToUndefined(process.env.SMTP_HOST),
    SMTP_PORT: blankToUndefined(process.env.SMTP_PORT) ?? "587",
    SMTP_SECURE: blankToUndefined(process.env.SMTP_SECURE),
    SMTP_USER: blankToUndefined(process.env.SMTP_USER),
    SMTP_PASSWORD: blankToUndefined(process.env.SMTP_PASSWORD),
    EMAIL_FROM: blankToUndefined(process.env.EMAIL_FROM),
  });
  if (!parsed.success) throw new ConfigError(issuesOf(parsed.error));
  if (parsed.data.SMTP_USER && !parsed.data.SMTP_PASSWORD) {
    throw new ConfigError(["SMTP_PASSWORD is required when SMTP_USER is set"]);
  }
  return parsed.data;
}

export type ConfigStatus = { ok: true } | { ok: false; issues: string[] };

export function getConfigStatus(scope: "core" | "smtp"): ConfigStatus {
  try {
    if (scope === "core") getCoreEnv();
    else getSmtpEnv();
    return { ok: true };
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, issues: err.issues };
    throw err;
  }
}

export function isProduction() {
  return process.env.NODE_ENV === "production";
}
