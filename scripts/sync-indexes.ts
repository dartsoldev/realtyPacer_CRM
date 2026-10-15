/**
 * Creates/updates every MongoDB index declared in the Mongoose schemas
 * (including TTL indexes). Run once per environment and after schema changes:
 *   npm run db:indexes
 */
import "./_env";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { ALL_MODELS } from "@/lib/db/models";
import { Booking } from "@/lib/db/models/booking";
import { Cleaner } from "@/lib/db/models/cleaner";
import { CustomFieldDefinition } from "@/lib/db/models/custom-field";
import { Customer } from "@/lib/db/models/customer";

async function main() {
  await connectDb();
  for (const model of ALL_MODELS) {
    const dropped = await model.syncIndexes();
    const indexes = await model.listIndexes();
    console.log(`✔ ${model.modelName}: ${indexes.length} indexes${dropped.length ? ` (dropped ${dropped.join(", ")})` : ""}`);
  }
  // Custom fields marked "indexed" (syncIndexes above removed any that are no longer wanted).
  const defs = await CustomFieldDefinition.find({ indexed: true, archivedAt: null }).select("entityType key").lean();
  const byEntity = { customer: Customer, booking: Booking, cleaner: Cleaner } as const;
  for (const d of defs) {
    if (!/^cf_[a-z0-9]{8}$/.test(d.key)) continue;
    const model = byEntity[d.entityType as keyof typeof byEntity];
    await model.collection.createIndex({ organizationId: 1, [`customFields.${d.key}`]: 1 }, { name: `cf_${d.entityType}_${d.key}` });
  }
  console.log(`✔ Custom field indexes: ${defs.length}`);
}

main()
  .catch((err) => {
    console.error("✖ Index sync failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
