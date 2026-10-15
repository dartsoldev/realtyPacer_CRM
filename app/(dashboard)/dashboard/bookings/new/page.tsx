import type { Metadata } from "next";
import { BookingForm } from "@/components/ops/booking-form";
import { AccessDenied } from "@/components/shell/access";
import { Card, PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { isDateKey } from "@/lib/domain/zoned-time";
import { activeServicesForBooking } from "@/modules/catalog/service";
import { assignableCleaners } from "@/modules/cleaners/service";
import { getCustomer } from "@/modules/customers/service";

export const metadata: Metadata = { title: "New booking" };

export default async function NewBookingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePageUser("/dashboard/bookings/new");
  if (!can(user, "bookings:write")) return <AccessDenied />;
  const sp = await searchParams;
  const customerId = typeof sp.customerId === "string" && OBJECT_ID_RE.test(sp.customerId) ? sp.customerId : null;
  const date = typeof sp.date === "string" && isDateKey(sp.date) ? sp.date : undefined;
  const time = typeof sp.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(sp.time) ? sp.time : undefined;
  const [services, cleaners, customer] = await Promise.all([
    activeServicesForBooking(user),
    assignableCleaners(user),
    customerId && can(user, "customers:read") ? getCustomer(user, customerId).catch(() => null) : Promise.resolve(null),
  ]);

  return (
    <>
      <PageHeader title={`New ${user.organization.terminology.booking.toLowerCase()}`} description={`Times are in ${user.organization.timezone}. Prices and the subtotal are calculated on the server when you save.`} />
      <Card className="p-5 sm:p-6">
        <BookingForm
          mode="create"
          options={{
            services,
            cleaners,
            timezone: user.organization.timezone,
            currency: user.organization.currency,
            canPrice: can(user, "pricing:read"),
            canOverride: can(user, "pricing:read") && can(user, "bookings:price_override"),
            canCreateCustomer: can(user, "customers:write"),
          }}
          prefill={{
            customer: customer && !customer.archived ? { id: customer.id, name: customer.name, phoneDisplay: customer.phoneDisplay, email: customer.email, primaryCity: customer.primaryCity } : null,
            date,
            time,
          }}
        />
      </Card>
    </>
  );
}
