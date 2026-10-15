import type { Metadata } from "next";
import { headers } from "next/headers";
import { BarChart3, CalendarClock, Camera, CreditCard, PhoneCall, ShieldCheck, Smartphone, Users } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { siteUrl } from "@/lib/site";

const TITLE = "RealtyPacer — CRM for cleaning and service businesses";
const DESCRIPTION =
  "RealtyPacer keeps customers, service addresses, job scheduling, cleaner assignments, payments received and reports in one place for cleaning and service teams.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { type: "website", url: "/", siteName: "RealtyPacer", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  robots: { index: true, follow: true },
};

const features = [
  { icon: Users, title: "Customers and addresses", body: "One profile per customer with phone, email, several service addresses, map links, access notes, tags, custom fields and the full service history." },
  { icon: CalendarClock, title: "Scheduling and assignments", body: "Book one or more services, assign cleaners with automatic double-booking checks, and follow each job on a day, week, month or agenda calendar." },
  { icon: PhoneCall, title: "Calling", body: "Tap a number to call from your phone and log the outcome. Browser calling through Twilio is available when your organization configures it." },
  { icon: CreditCard, title: "Charges and payments", body: "Finalize charges, record payments received by cash, e-Transfer, cheque or an external card terminal, apply credit and record refunds. RealtyPacer does not process card payments." },
  { icon: BarChart3, title: "Reports", body: "Combine filters such as city, service and date range, see totals that match exactly what is filtered, save views and export CSV." },
  { icon: Camera, title: "Photos and documents", body: "Keep property and before/after photos with the address or job, stored privately and shown only to people with access." },
  { icon: Smartphone, title: "Works on any device", body: "Responsive screens for the office and a focused job view for cleaners. It can be added to a phone’s home screen; it is a web app, not an app-store app." },
  { icon: ShieldCheck, title: "Team access", body: "Invitations, roles and per-permission access, email verification, password reset and an audit history of administrative changes." },
] as const;

export default async function HomePage() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "RealtyPacer",
    url: siteUrl(),
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web browser",
    description: DESCRIPTION,
  };
  return (
    <>
      <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <section className="border-b border-line bg-gradient-to-b from-brand-soft/60 to-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand">CRM for cleaning and service businesses</p>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-ink sm:text-5xl">Keep customers, jobs and payments moving at the right pace.</h1>
          <p className="mt-5 max-w-2xl text-lg text-muted">
            From the first call to the completed job and the payment received: customer profiles, service addresses, scheduling, cleaner assignments, calling, charges, payments and reporting in one workspace.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <LinkButton href="/login">Sign in to your workspace</LinkButton>
          </div>
          <p className="mt-4 text-sm text-muted">Accounts are created by invitation from your organization’s administrator.</p>
        </div>
      </section>

      <section aria-labelledby="features-heading" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="features-heading" className="text-2xl font-semibold tracking-tight">What RealtyPacer does</h2>
        <p className="mt-2 max-w-2xl text-muted">The daily workflow: customer → address → booking → services → cleaner → completed job → charges and payments → reports.</p>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, title, body }) => (
            <li key={title} className="rounded-xl border border-line bg-surface p-5">
              <span className="flex size-10 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <Icon className="size-5" aria-hidden />
              </span>
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-muted">{body}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
