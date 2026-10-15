import type { MetadataRoute } from "next";

/** Installable web app (home-screen shortcut). Not a native App Store / Play Store app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RealtyPacer",
    short_name: "RealtyPacer",
    description: "CRM for cleaning and service businesses: customers, jobs, payments and reports.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: "#DC2626",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
