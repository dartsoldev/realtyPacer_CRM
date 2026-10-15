import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingForm } from "@/components/ops/booking-form";
import { AccessDenied } from "@/components/shell/access";
import { Card, PageHeader } from "@/components/ui/layout";
import { can } from "@/lib/auth/current-user";
import { requirePageUser } from "@/lib/auth/page-guard";
import { AppError } from "@/lib/http/errors";
import { getBooking } from "@/modules/bookings/service";
import { activeServicesForBooking } from "@/modules/catalog/service";
import { assignableCleaners } from "@/modules/cleaners/service";

export const metadata: Metadata = { title: "Edit booking" };

export default async function EditBookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageUser(`/dashboard/bookings/${id}/edit`);
  if (!can(user, "bookings:write")) return <AccessDenied />;
  let booking;
  try {
    booking = await getBooking(user, id);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) notFound();
    throw err;
  }
  const [services, cleaners] = await Promise.all([activeServicesForBooking(user), assignableCleaners(user)]);
  return (
    <>
      <PageHeader title={`Edit ${booking.reference}`} description="If someone else saves this booking while you edit, you’ll be asked to reload instead of overwriting their changes." />
      <Card className="p-5 sm:p-6">
        <BookingForm
          mode="edit"
          initial={booking}
          options={{
            services,
            cleaners,
            timezone: user.organization.timezone,
            currency: user.organization.currency,
            canPrice: can(user, "pricing:read"),
            canOverride: can(user, "pricing:read") && can(user, "bookings:price_override"),
            canCreateCustomer: false,
          }}
        />
      </Card>
    </>
  );
}
