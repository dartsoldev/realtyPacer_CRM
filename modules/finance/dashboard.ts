import "server-only";
import { Types } from "mongoose";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Booking } from "@/lib/db/models/booking";
import { Payment } from "@/lib/db/models/payment";
import { Refund } from "@/lib/db/models/refund";
import { localDaysRange } from "@/lib/domain/zoned-time";
import { Errors } from "@/lib/http/errors";
import { resolveDatePreset } from "@/modules/reports/definition";

/**
 * Dashboard financial cards. Each figure states its date basis; all come
 * from authoritative records (no stored totals). No growth percentages.
 */
export async function financialCards(user: CurrentUser) {
  if (!user.permissions.has("financials:read")) throw Errors.forbidden();
  await connectDb();
  const orgId = new Types.ObjectId(user.organizationId);
  const tz = user.organization.timezone;
  const month = resolveDatePreset("this_month", tz)!;
  const { start, end } = localDaysRange(month.from, month.to, tz);
  const [receipts, refunds, owed, credit, completed] = await Promise.all([
    Payment.aggregate<{ t: number }>([{ $match: { organizationId: orgId, status: "POSTED", receivedAt: { $gte: start, $lt: end } } }, { $group: { _id: null, t: { $sum: "$amountCents" } } }]),
    Refund.aggregate<{ t: number }>([{ $match: { organizationId: orgId, refundedAt: { $gte: start, $lt: end } } }, { $group: { _id: null, t: { $sum: "$amountCents" } } }]),
    Booking.aggregate<{ t: number; n: number }>([
      { $match: { organizationId: orgId, billingState: "FINALIZED" } },
      { $project: { bal: { $subtract: [{ $add: ["$chargedCents", { $ifNull: ["$adjustmentsCents", 0] }] }, { $ifNull: ["$allocatedCents", 0] }] } } },
      { $match: { bal: { $gt: 0 } } },
      { $group: { _id: null, t: { $sum: "$bal" }, n: { $sum: 1 } } },
    ]),
    Payment.aggregate<{ t: number }>([{ $match: { organizationId: orgId, status: "POSTED", unallocatedCents: { $gt: 0 } } }, { $group: { _id: null, t: { $sum: "$unallocatedCents" } } }]),
    Booking.aggregate<{ t: number }>([
      { $match: { organizationId: orgId, status: "COMPLETED", billingState: "FINALIZED", scheduledStartAt: { $gte: start, $lt: end } } },
      { $group: { _id: null, t: { $sum: { $add: ["$chargedCents", { $ifNull: ["$adjustmentsCents", 0] }] } } } },
    ]),
  ]);
  const r = receipts[0]?.t ?? 0;
  const f = refunds[0]?.t ?? 0;
  return {
    currency: user.organization.currency,
    month,
    cashThisMonth: { receiptsCents: r, refundsCents: f, netCents: r - f, basis: "Receipt/refund date, this month" },
    outstandingNow: { cents: owed[0]?.t ?? 0, bookings: owed[0]?.n ?? 0, basis: "Finalized charges not yet paid, as of now (all dates)" },
    creditNow: { cents: credit[0]?.t ?? 0, basis: "Received but not applied to any charge, as of now" },
    completedChargedThisMonth: { cents: completed[0]?.t ?? 0, basis: "Completed jobs by service date this month, finalized charges" },
  };
}
