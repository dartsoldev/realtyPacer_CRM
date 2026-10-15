import "server-only";
import type { CurrentUser } from "@/lib/auth/current-user";
import { pingDatabase } from "@/lib/diagnostics";
import { callingMode, getConfigStatus } from "@/lib/env";
import { Errors } from "@/lib/http/errors";
import { outboxOverview } from "@/modules/outbox/service";
import packageJson from "@/package.json";

/** Operational diagnostics for administrators (system:diagnostics). Names problems, never values. */
export async function systemStatus(user: CurrentUser) {
  if (!user.permissions.has("system:diagnostics")) throw Errors.forbidden();
  const [db, outbox] = await Promise.all([pingDatabase(), outboxOverview(user)]);
  const calling = getConfigStatus("calling");
  const storage = getConfigStatus("storage");
  const smtp = getConfigStatus("smtp");
  const beatAgeSeconds = outbox.worker ? Math.round((Date.now() - new Date(outbox.worker.beatAt).getTime()) / 1000) : null;
  return {
    checkedAt: new Date().toISOString(),
    version: process.env.APP_VERSION || packageJson.version,
    node: process.version,
    database: db,
    email: { configured: smtp.ok, issues: smtp.ok ? [] : smtp.issues },
    storage: { configured: storage.ok, issues: storage.ok ? [] : storage.issues.filter((i) => !i.includes("not set")) },
    calling: { mode: callingMode(), configured: calling.ok, issues: callingMode() === "browser" && !calling.ok ? calling.issues : [] },
    worker: { lastBeat: outbox.worker?.beatAt ?? null, ageSeconds: beatAgeSeconds, healthy: beatAgeSeconds !== null && beatAgeSeconds < 120, lastResult: outbox.worker?.lastResult ?? null },
    outbox: { counts: outbox.counts, attention: outbox.attention },
  };
}

export type SystemStatus = Awaited<ReturnType<typeof systemStatus>>;
