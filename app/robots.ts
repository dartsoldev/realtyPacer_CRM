import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

/**
 * Crawler guidance only — robots.txt is not access control. Private routes
 * are protected server-side and also send `X-Robots-Tag: noindex`.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/dashboard", "/api/", "/login", "/forgot-password", "/reset-password", "/verify-email", "/accept-invitation", "/offline.html"] }],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
