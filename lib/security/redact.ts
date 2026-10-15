/**
 * Redaction for logs and audit metadata. Secrets are removed entirely;
 * personal data (emails) is masked.
 */
const SECRET_KEY_RE = /pass(word)?|secret|token|authorization|cookie|session|api[-_]?key|smtp|hash|credential/i;
const EMAIL_RE = /([a-z0-9._%+-])[a-z0-9._%+-]*@([a-z0-9.-]+\.[a-z]{2,})/gi;
const MONGO_URI_RE = /mongodb(\+srv)?:\/\/[^\s@]+@/gi;

export function maskEmail(email: string): string {
  return email.replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***@${domain}`);
}

export function redactString(value: string): string {
  return maskEmail(value.replace(MONGO_URI_RE, "mongodb$1://[redacted]@"));
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}
