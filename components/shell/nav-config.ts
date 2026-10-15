import {
  Activity,
  BarChart3,
  Briefcase,
  CalendarDays,
  ClipboardList,
  CreditCard,
  Filter,
  Inbox,
  Plug,
  LayoutDashboard,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/permissions/matrix";

export type Terminology = { customer: string; booking: string; provider: string };

export type NavItem = {
  href: string;
  label: (t: Terminology) => string;
  icon: LucideIcon;
  permission: Permission;
  section: "main" | "more" | "admin";
};

export function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: () => "Dashboard", icon: LayoutDashboard, permission: "dashboard:view", section: "main" },
  { href: "/dashboard/customers", label: (t) => plural(t.customer), icon: Users, permission: "customers:read", section: "main" },
  { href: "/dashboard/customer-filter", label: () => "Customer filter", icon: Filter, permission: "reports:read", section: "main" },
  { href: "/dashboard/calendar", label: () => "Calendar", icon: CalendarDays, permission: "calendar:read", section: "main" },
  { href: "/dashboard/bookings", label: (t) => plural(t.booking), icon: ClipboardList, permission: "bookings:read", section: "main" },
  { href: "/dashboard/leads", label: () => "Leads", icon: Inbox, permission: "leads:read", section: "main" },
  { href: "/dashboard/cleaners", label: (t) => plural(t.provider), icon: Briefcase, permission: "cleaners:read", section: "main" },
  { href: "/dashboard/services", label: () => "Services", icon: Sparkles, permission: "services:read", section: "more" },
  { href: "/dashboard/payments", label: () => "Payments", icon: CreditCard, permission: "financials:read", section: "more" },
  { href: "/dashboard/reports", label: () => "Advanced reports", icon: BarChart3, permission: "reports:read", section: "more" },
  { href: "/dashboard/users", label: () => "Users", icon: UserCog, permission: "users:read", section: "admin" },
  { href: "/dashboard/custom-fields", label: () => "Custom fields", icon: SlidersHorizontal, permission: "customFields:manage", section: "admin" },
  { href: "/dashboard/settings/integrations", label: () => "Integrations", icon: Plug, permission: "integrations:manage", section: "admin" },
  { href: "/dashboard/organization", label: () => "Organization", icon: Settings2, permission: "organization:read", section: "admin" },
  { href: "/dashboard/system", label: () => "System status", icon: Activity, permission: "system:diagnostics", section: "admin" },
  { href: "/dashboard/audit", label: () => "Audit history", icon: ScrollText, permission: "audit:read", section: "admin" },
];
