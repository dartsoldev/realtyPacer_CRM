/**
 * Background worker — a REQUIRED deployment component when booking emails or
 * queued security notifications are used. Delivers the email outbox with
 * retries/backoff and writes a heartbeat visible in System status.
 *
 *   npm run worker            # long-running (one or more replicas)
 *   npm run worker -- --once  # one batch, then exit (cron / tests)
 *
 * Several workers can run at once: each message is claimed atomically.
 * SIGTERM/SIGINT finish the current batch, then exit.
 */
import "./_env";
import { parseArgs } from "node:util";
import { connectDb, disconnectDb } from "@/lib/db/connect";
import { getCoreEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { cleanupStaleUploads } from "@/modules/attachments/service";
import { processCalendarSyncBatch, verifyLinkedEvents } from "@/modules/integrations/google-calendar";
import { processOutboxBatch, recordHeartbeat } from "@/modules/outbox/service";
import { storageConfigured } from "@/lib/storage";

const { values } = parseArgs({ options: { once: { type: "boolean", default: false } } });
const pollMs = Math.max(2, Math.min(300, Number(process.env.WORKER_POLL_SECONDS) || 15)) * 1000;
let stopping = false;
let lastCleanup = 0;
let lastVerify = 0;
let wake: (() => void) | null = null;

function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info("worker.stopping", { signal });
  wake?.();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

async function main() {
  getCoreEnv(); // fail fast on missing configuration
  await connectDb();
  logger.info("worker.started", { pollSeconds: pollMs / 1000, once: values.once });
  do {
    try {
      const result = await processOutboxBatch(50);
      await recordHeartbeat("outbox", result);
      if (result.sent || result.retried || result.failed) logger.info("worker.outbox_batch", result);
      const cal = await processCalendarSyncBatch(25);
      if (cal.synced || cal.retried || cal.failed) logger.info("worker.calendar_batch", cal);
      if (Date.now() - lastVerify > 60 * 60 * 1000) {
        lastVerify = Date.now();
        const v = await verifyLinkedEvents();
        if (v.flagged) logger.info("worker.calendar_external_changes", v);
      }
      // Hourly-ish housekeeping: abandoned (never completed) uploads.
      if (storageConfigured() && Date.now() - lastCleanup > 60 * 60 * 1000) {
        lastCleanup = Date.now();
        const removed = await cleanupStaleUploads();
        if (removed) logger.info("worker.stale_uploads_removed", { removed });
      }
    } catch (err) {
      logger.error("worker.batch_error", { error: err instanceof Error ? err : String(err) });
    }
    if (values.once || stopping) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  } while (!stopping);
}

main()
  .catch((err) => {
    logger.error("worker.fatal", { error: err instanceof Error ? err : String(err) });
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
