/**
 * Data migrations. Idempotent — safe to run on every release, after
 * `sync-indexes`. Never runs automatically on application start.
 *
 *   npm run db:migrate            # indexes + migrations
 *   node dist/migrate.cjs         # migrations only (container)
 *
 * 2026-10 report-snapshot: copies booking reference, city and service name
 * onto payment allocations and refund portions written before those fields
 * existed (cash reports read them instead of joining bookings per row).
 */
import "./_env";
import { Types } from "mongoose";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { Booking } from "@/lib/db/models/booking";
import { Payment } from "@/lib/db/models/payment";
import { Refund } from "@/lib/db/models/refund";

type Snap = { bookingReference: string | null; city: string | null; cityNormalized: string | null; serviceName: string | null };

async function snapshotsFor(bookingIds: Types.ObjectId[]) {
  const rows = await Booking.find({ _id: { $in: bookingIds } }).select("reference addressSnapshot.city addressSnapshot.cityNormalized lineItems._id lineItems.name").lean();
  const map = new Map<string, Snap>();
  for (const b of rows) {
    for (const l of b.lineItems) {
      map.set(`${b._id}:${l._id}`, { bookingReference: b.reference, city: b.addressSnapshot?.city ?? null, cityNormalized: b.addressSnapshot?.cityNormalized ?? null, serviceName: l.name });
    }
  }
  return map;
}

async function backfillAllocations() {
  let updated = 0;
  const cursor = Payment.find({ allocations: { $elemMatch: { bookingReference: { $in: [null, undefined] } } } }).select("allocations").lean().cursor({ batchSize: 200 });
  let batch: { _id: Types.ObjectId; allocations: { _id: Types.ObjectId; bookingId: Types.ObjectId; lineItemId: Types.ObjectId; bookingReference?: string | null }[] }[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const snaps = await snapshotsFor([...new Set(batch.flatMap((p) => p.allocations.map((a) => String(a.bookingId))))].map((id) => new Types.ObjectId(id)));
    const ops = batch.flatMap((p) =>
      p.allocations
        .filter((a) => !a.bookingReference && snaps.has(`${a.bookingId}:${a.lineItemId}`))
        .map((a) => ({
          updateOne: {
            filter: { _id: p._id },
            update: { $set: Object.fromEntries(Object.entries(snaps.get(`${a.bookingId}:${a.lineItemId}`)!).map(([k, v]) => [`allocations.$[al].${k}`, v])) },
            arrayFilters: [{ "al._id": a._id }],
          },
        })),
    );
    if (ops.length) updated += (await Payment.bulkWrite(ops as never, { ordered: false })).modifiedCount;
    batch = [];
  };
  for await (const p of cursor) {
    batch.push(p as never);
    if (batch.length >= 200) await flush();
  }
  await flush();
  return updated;
}

async function backfillRefundPortions() {
  let updated = 0;
  const cursor = Refund.find({ portions: { $elemMatch: { bookingId: { $ne: null }, bookingReference: { $in: [null, undefined] } } } }).select("portions").lean().cursor({ batchSize: 200 });
  for await (const r of cursor) {
    const ids = [...new Set(r.portions.filter((x) => x.bookingId).map((x) => String(x.bookingId)))].map((id) => new Types.ObjectId(id));
    const snaps = await snapshotsFor(ids);
    const portions = r.portions.map((x) => (x.bookingId && !x.bookingReference && snaps.has(`${x.bookingId}:${x.lineItemId}`) ? { ...x, ...snaps.get(`${x.bookingId}:${x.lineItemId}`) } : x));
    const res = await Refund.updateOne({ _id: r._id }, { $set: { portions } });
    updated += res.modifiedCount;
  }
  return updated;
}

async function main() {
  await connectDb();
  const allocations = await backfillAllocations();
  const refunds = await backfillRefundPortions();
  console.log(`✔ report-snapshot: ${allocations} payment(s) and ${refunds} refund(s) updated`);
}

main()
  .catch((err) => {
    console.error("✖ Migration failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
