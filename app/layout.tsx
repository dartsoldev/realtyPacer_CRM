import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import localFont from "next/font/local";
import "./globals.css";
import { ServiceWorkerRegister } from "@/components/shell/pwa";
import { siteUrl } from "@/lib/site";

// Inter (SIL OFL) self-hosted from the @fontsource-variable package via next/font.
const inter = localFont({
  src: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: "RealtyPacer — CRM for service businesses", template: "%s · RealtyPacer" },
  description: "RealtyPacer helps service businesses keep customers, schedules and reporting in one place.",
  applicationName: "RealtyPacer",
  appleWebApp: { capable: true, title: "RealtyPacer", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#DC2626",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Every page renders per request so proxy.ts can attach a CSP nonce to Next.js scripts.
  await connection();
  return (
    <html lang="en" className={inter.variable}>
      <body className="min-h-dvh font-sans">
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
