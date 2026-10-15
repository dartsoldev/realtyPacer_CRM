import "server-only";
import { Types } from "mongoose";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Booking } from "@/lib/db/models/booking";
import { Customer } from "@/lib/db/models/customer";
import { Service } from "@/lib/db/models/service";
import { User } from "@/lib/db/models/user";

export type DashboardSummary = {
  users?: { active: number; invited: number; suspended: number };
  customers?: number;
  activeServices?: number;
  upcomingBookings?: number;
};

/**
 * Real, permission-filtered counts. Modules not yet built simply report 0 —
 * the UI pairs zeros with honest "arrives in phase N" empty states.
 */
export async function getDashboardSummary(actor: CurrentUser): Promise<DashboardSummary> {
  await connectDb();
  const organizationId = new Types.ObjectId(actor.organizationId);
  const p = actor.permissions;
  const tasks: Array<Promise<void>> = [];
  const out: DashboardSummary = {};

  if (p.has("users:read")) {
    tasks.push(
      User.aggregate<{ _id: string; n: number }>([
        { $match: { organizationId } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]).then((rows) => {
        const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
        out.users = { active: by.active ?? 0, invited: by.invited ?? 0, suspended: by.suspended ?? 0 };
      }),
    );
  }
  if (p.has("customers:read")) tasks.push(Customer.countDocuments({ organizationId }).then((n) => void (out.customers = n)));
  if (p.has("services:read")) tasks.push(Service.countDocuments({ organizationId, active: true }).then((n) => void (out.activeServices = n)));
  if (p.has("bookings:read")) {
    tasks.push(
      Booking.countDocuments({ organizationId, scheduledStartAt: { $gte: new Date() }, status: { $in: ["SCHEDULED", "IN_PROGRESS"] } }).then(
        (n) => void (out.upcomingBookings = n),
      ),
    );
  }
  await Promise.all(tasks);
  return out;
}
