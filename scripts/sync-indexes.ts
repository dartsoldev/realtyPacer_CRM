/**
 * Creates/updates every MongoDB index declared in the Mongoose schemas
 * (including TTL indexes). Run once per environment and after schema changes:
 *   npm run db:indexes
 */
import "./_env";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { ALL_MODELS } from "@/lib/db/models";

async function main() {
  await connectDb();
  for (const model of ALL_MODELS) {
    const dropped = await model.syncIndexes();
    const indexes = await model.listIndexes();
    console.log(`✔ ${model.modelName}: ${indexes.length} indexes${dropped.length ? ` (dropped ${dropped.join(", ")})` : ""}`);
  }
}

main()
  .catch((err) => {
    console.error("✖ Index sync failed:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
