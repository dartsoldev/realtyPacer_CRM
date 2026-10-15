import { NextResponse, type NextRequest } from "next/server";

/**
 * Runs before every request (Node.js runtime):
 *  - a correlation id (`x-request-id`) for logs and error reports;
 *  - a per-request nonce Content-Security-Policy for pages. Pages render
 *    dynamically (root layout calls `connection()`), so Next.js attaches the
 *    nonce to its own scripts and no `'unsafe-inline'` script is needed.
 * Optional integrations only widen the policy when they are configured, and
 * the decision is made at runtime (not baked into the build).
 */

function storageOrigin(): string | null {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return null;
  const configured = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT;
  try {
    if (configured) return new URL(configured).origin;
  } catch {
    return null;
  }
  const region = process.env.S3_REGION || "us-east-1";
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

function contentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV !== "production";
  const browserCalling = process.env.CALLING_MODE === "browser";
  const connect = ["'self'"];
  if (isDev) connect.push("ws:");
  if (browserCalling) connect.push("https://*.twilio.com", "wss://*.twilio.com");
  const storage = storageOrigin();
  if (storage) connect.push(storage); // direct, presigned uploads only; reads go through the app
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes (layout, FullCalendar) are allowed; inline scripts are not.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `media-src 'self'${browserCalling ? " https://sdk.twilio.com" : ""}`,
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    // Only when the site is served over HTTPS; on plain-HTTP hosts it would break lazily loaded chunks.
    ...(!isDev && (process.env.APP_URL ?? "").startsWith("https://") ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const incoming = request.headers.get("x-request-id");
  const requestId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", requestId);

  const isPage = !request.nextUrl.pathname.startsWith("/api/");
  let csp: string | null = null;
  if (isPage) {
    const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
    csp = contentSecurityPolicy(nonce);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", csp);
  }
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("x-request-id", requestId);
  if (csp) response.headers.set("Content-Security-Policy", csp);
  response.headers.set(
    "Permissions-Policy",
    `camera=(), geolocation=(), payment=(), microphone=(${process.env.CALLING_MODE === "browser" ? "self" : ""})`,
  );
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
