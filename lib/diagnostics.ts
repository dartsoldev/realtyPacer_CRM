import "server-only";
import { connectDb } from "@/lib/db/connect";
import { getConfigStatus } from "@/lib/env";

/** Database ping with a timeout; never throws. */
export async function pingDatabase(timeoutMs = Math.min(15_000, Math.max(500, Number(process.env.READINESS_TIMEOUT_MS) || 3000))): Promise<{ ok: boolean; latencyMs: number | null }> {
  if (!getConfigStatus("core").ok) return { ok: false, latencyMs: null };
  const started = Date.now();
  try {
    await Promise.race([
      (async () => {
        const m = await connectDb();
        await m.connection.db?.admin().ping();
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: null };
  }
}
