import "server-only";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { getCoreEnv } from "@/lib/env";
import { authenticateWithPassword } from "@/modules/auth/login";

export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * NextAuth v4 (stable) configuration.
 *
 * Session strategy: JWT in an encrypted, HttpOnly, SameSite=Lax cookie
 * (`__Secure-` prefixed over HTTPS). The Credentials provider in v4 only works
 * with JWT sessions; revocation is handled by comparing the token's `sv`
 * (sessionVersion) with the user's current value on every protected request
 * — see lib/auth/current-user.ts.
 *
 * Built lazily so `next build` works without secrets.
 */
export function getAuthOptions(): NextAuthOptions {
  const env = getCoreEnv();
  return {
    secret: env.NEXTAUTH_SECRET,
    session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS, updateAge: 60 * 60 },
    jwt: { maxAge: SESSION_MAX_AGE_SECONDS },
    pages: { signIn: "/login", error: "/login" },
    providers: [
      CredentialsProvider({
        id: "credentials",
        name: "Email and password",
        credentials: {
          email: { label: "Email", type: "email" },
          password: { label: "Password", type: "password" },
        },
        async authorize(credentials, req) {
          // Throws Error("RateLimited" | "EmailNotVerified") or returns null for generic failure.
          const user = await authenticateWithPassword({
            email: credentials?.email,
            password: credentials?.password,
            headers: req?.headers,
          });
          return user;
        },
      }),
    ],
    callbacks: {
      async jwt({ token, user }) {
        if (user) {
          const u = user as unknown as { id: string; organizationId: string; sessionVersion: number };
          token.sub = u.id;
          token.oid = u.organizationId;
          token.sv = u.sessionVersion;
        }
        return token;
      },
      async session({ session, token }) {
        // Minimal client-visible session. Roles/permissions are always
        // resolved server-side from the database, never trusted from here.
        return {
          expires: session.expires,
          user: { id: token.sub ?? "", name: session.user?.name ?? null, email: session.user?.email ?? null },
          oid: typeof token.oid === "string" ? token.oid : "",
          sv: typeof token.sv === "number" ? token.sv : -1,
        };
      },
      async redirect({ url, baseUrl }) {
        if (url.startsWith("/") && !url.startsWith("//")) return `${baseUrl}${url}`;
        try {
          if (new URL(url).origin === baseUrl) return url;
        } catch {
          /* fall through */
        }
        return `${baseUrl}/dashboard`;
      },
    },
    logger: {
      // Keep NextAuth's own logging terse and secret-free.
      error(code) {
        console.error(JSON.stringify({ level: "error", event: "nextauth.error", code }));
      },
      warn(code) {
        if (process.env.NODE_ENV !== "production") console.warn(JSON.stringify({ level: "warn", event: "nextauth.warn", code }));
      },
      debug() {},
    },
  };
}
