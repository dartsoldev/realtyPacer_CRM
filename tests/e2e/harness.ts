import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { SMTPServer } from "smtp-server";

/**
 * End-to-end harness: runs the PRODUCTION build (`.next/standalone/server.js`)
 * against a throwaway database and a local SMTP sink, and talks to it over
 * real HTTP with cookies — the same path a browser takes.
 */

export const ROOT = path.resolve(__dirname, "../..");

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export type Mail = { to: string[]; raw: string };

export async function startSmtpSink() {
  const messages: Mail[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS", "AUTH"],
    logger: false,
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        messages.push({ to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString("utf8") });
        cb();
      });
    },
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return { port, messages, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

export function tokenIn(mail: Mail, route: string): string {
  const unfolded = mail.raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  const m = unfolded.match(new RegExp(`${route}\\?token=([A-Za-z0-9_-]{43})`));
  if (!m?.[1]) throw new Error(`no ${route} token in mail`);
  return m[1];
}

/** Environment for the app under test. Every service is local or throwaway; nothing real is contacted. */
export function e2eEnv(opts: { port: number; mongoUri: string; smtpPort: number }): NodeJS.ProcessEnv {
  const origin = `http://127.0.0.1:${opts.port}`;
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: "production",
    PORT: String(opts.port),
    HOSTNAME: "127.0.0.1",
    MONGODB_URI: opts.mongoUri,
    APP_URL: origin,
    NEXTAUTH_URL: origin,
    NEXTAUTH_SECRET: randomBytes(48).toString("base64url"),
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(opts.smtpPort),
    SMTP_SECURE: "false",
    // Explicitly blank so no real credentials from a local .env can ever be used here.
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    EMAIL_FROM: "RealtyPacer E2E <e2e@example.test>",
    TRUST_PROXY_HEADERS: "false",
    CALLING_MODE: "tel",
    S3_BUCKET: "",
    SUPERADMIN_EMAIL: "",
    WORKER_POLL_SECONDS: "2",
    // Remote test clusters can be slow to answer a ping.
    READINESS_TIMEOUT_MS: "12000",
  };
}

export async function startApp(env: NodeJS.ProcessEnv): Promise<{ origin: string; proc: ChildProcess; logs: string[] }> {
  const server = path.join(ROOT, ".next/standalone/server.js");
  if (!existsSync(server)) throw new Error("Run `npm run build` first: the e2e suite tests the production build.");
  // Same layout as the container image: static assets and public files next to server.js.
  cpSync(path.join(ROOT, ".next/static"), path.join(ROOT, ".next/standalone/.next/static"), { recursive: true });
  cpSync(path.join(ROOT, "public"), path.join(ROOT, ".next/standalone/public"), { recursive: true });
  const logs: string[] = [];
  const proc = spawn(process.execPath, [server], { cwd: path.dirname(server), env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout!.on("data", (d) => logs.push(String(d)));
  proc.stderr!.on("data", (d) => logs.push(String(d)));
  const origin = env.APP_URL!;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${origin}/api/v1/ready`);
      if (r.ok) return { origin, proc, logs };
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) throw new Error(`app exited early:\n${logs.join("").slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`app did not become ready:\n${logs.join("").slice(-2000)}`);
}

export function runCli(script: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, "dist", script), ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.stderr.on("data", (d) => (out += String(d)));
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** Minimal browser-like client: cookie jar, same-origin Origin header, JSON helpers. */
export class Client {
  private cookies = new Map<string, string>();
  constructor(readonly origin: string) {}

  private store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1);
      if (/expires=Thu, 01 Jan 1970/i.test(c) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async raw(pathname: string, init: RequestInit & { origin?: string | null } = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", this.cookieHeader());
    if (init.origin !== null && init.method && init.method !== "GET") headers.set("origin", init.origin ?? this.origin);
    const res = await fetch(`${this.origin}${pathname}`, { ...init, headers, redirect: "manual" });
    this.store(res);
    return res;
  }

  async json<T = unknown>(method: string, pathname: string, body?: unknown, extra: { origin?: string | null } = {}) {
    const res = await this.raw(pathname, { method, origin: extra.origin, headers: body !== undefined || method !== "GET" ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : method !== "GET" ? "{}" : undefined });
    const text = await res.text();
    let data: { data?: T; error?: { code: string; message: string } } = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, data: data.data as T, error: data.error, text, headers: res.headers };
  }

  /** NextAuth credentials sign-in (CSRF token + form POST), as the login page does. */
  async signIn(email: string, password: string) {
    const csrf = await this.raw("/api/auth/csrf");
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const res = await this.raw("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken, email, password, json: "true", callbackUrl: `${this.origin}/dashboard` }).toString(),
    });
    const session = [...this.cookies.keys()].some((k) => k.includes("session-token"));
    return { status: res.status, location: res.headers.get("location") ?? "", session };
  }
}

export const key = () => randomBytes(16).toString("hex");
