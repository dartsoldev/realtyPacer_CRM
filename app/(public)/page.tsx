import type { Metadata } from "next";
import { BarChart3, CalendarClock, ShieldCheck, Users } from "lucide-react";
import { LinkButton } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = {
  title: { absolute: "RealtyPacer — CRM for cleaning and service businesses" },
  description:
    "RealtyPacer is a CRM for service businesses: keep customer profiles and service addresses together, schedule jobs, and report on what was booked and paid.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "RealtyPacer",
    title: "RealtyPacer — CRM for cleaning and service businesses",
    description: "Customer tracking, job scheduling and reporting for service teams.",
  },
  robots: { index: true, follow: true },
};

const features = [
  {
    icon: Users,
    title: "Customer tracking",
    body: "One profile per customer with contact details, multiple service addresses, and a history of every job and payment.",
    status: "Planned",
  },
  {
    icon: CalendarClock,
    title: "Scheduling",
    body: "Book services, assign cleaners and follow each job from scheduled to completed on a shared calendar.",
    status: "Planned",
  },
  {
    icon: BarChart3,
    title: "Reporting",
    body: "Combine filters such as city, service and date range to see matching bookings, amounts and payments allocated to them.",
    status: "Planned",
  },
  {
    icon: ShieldCheck,
    title: "Team access",
    body: "Invite your team with role-based permissions, keep an audit trail of administrative changes, and suspend access instantly.",
    status: "Available",
  },
] as const;

export default function HomePage() {
  return (
    <>
      <section className="border-b border-line bg-gradient-to-b from-brand-soft/60 to-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <p className="text-sm font-semibold uppercase tracking-wide text-brand">CRM for service businesses</p>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Keep customers, jobs and payments moving at the right pace.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted">
            RealtyPacer brings customer profiles, service addresses, job scheduling and reporting into one place — starting with the
            day-to-day workflow of cleaning teams.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <LinkButton href="/login">Sign in to your workspace</LinkButton>
          </div>
          <p className="mt-4 text-sm text-muted">Accounts are created by invitation from your organization’s administrator.</p>
        </div>
      </section>

      <section aria-labelledby="features-heading" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 id="features-heading" className="text-2xl font-semibold tracking-tight">
          What RealtyPacer is built to do
        </h2>
        <p className="mt-2 max-w-2xl text-muted">
          RealtyPacer is in early access. Team administration is live today; the remaining modules are being released in stages.
        </p>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {features.map(({ icon: Icon, title, body, status }) => (
            <li key={title} className="rounded-xl border border-line bg-surface p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex size-10 items-center justify-center rounded-lg bg-brand-soft text-brand">
                  <Icon className="size-5" aria-hidden />
                </span>
                <Badge tone={status === "Available" ? "success" : "info"}>{status}</Badge>
              </div>
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-muted">{body}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
