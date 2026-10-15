import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/*
 * Content-Security-Policy and Permissions-Policy are set per request in
 * proxy.ts (nonce-based scripts; optional integrations decided at runtime).
 * The headers below are static.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const privateHeaders = [
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Cache-Control", value: "private, no-store" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["@node-rs/argon2", "mongoose", "nodemailer", "twilio", "sharp"],
  // Self-contained server bundle for the container image (see Dockerfile).
  output: "standalone",
  images: {
    // No remote image sources are allowed until a specific host is reviewed.
    remotePatterns: [],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }, { key: "Service-Worker-Allowed", value: "/" }] },
      { source: "/dashboard/:path*", headers: privateHeaders },
      { source: "/dashboard", headers: privateHeaders },
      { source: "/api/:path*", headers: privateHeaders },
      { source: "/login", headers: privateHeaders },
      { source: "/forgot-password", headers: privateHeaders },
      { source: "/reset-password", headers: [...privateHeaders, { key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/verify-email", headers: [...privateHeaders, { key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/accept-invitation", headers: [...privateHeaders, { key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
