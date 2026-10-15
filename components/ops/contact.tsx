import { ExternalLink, Mail, MapPin, Phone } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { telHref } from "@/lib/domain/links";

const linkCls = "inline-flex items-center gap-1.5 rounded-md font-medium text-brand underline-offset-4 hover:underline";

/** Opens the device dialer. It is not an in-browser phone system and logs nothing by itself. */
export function PhoneLink({ e164, display, className, label }: { e164: string | null; display?: string | null; className?: string; label?: string }) {
  if (!e164) return null;
  return (
    <a href={telHref(e164)} className={cn(linkCls, className)} aria-label={label ?? `Call ${display ?? e164} (opens your phone app)`}>
      <Phone className="size-4" aria-hidden />
      {display ?? e164}
    </a>
  );
}

export function EmailLink({ email, className }: { email: string | null; className?: string }) {
  if (!email) return null;
  return (
    <a href={`mailto:${encodeURIComponent(email).replace("%40", "@")}`} className={cn(linkCls, "break-all", className)}>
      <Mail className="size-4 shrink-0" aria-hidden />
      {email}
    </a>
  );
}

/** External links always open safely (no opener, no referrer). */
export function ExternalAnchor({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn(linkCls, className)}>
      {children}
      <ExternalLink className="size-3.5" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export function MapLink({ href, className }: { href: string | null; className?: string }) {
  if (!href) return null;
  return (
    <ExternalAnchor href={href} className={className}>
      <MapPin className="size-4" aria-hidden />
      Open in Google Maps
    </ExternalAnchor>
  );
}
