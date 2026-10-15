import { NextResponse } from "next/server";
import { connectDb } from "@/lib/db/connect";
import { getConfigStatus } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness/config check. Reports only booleans — no variable names or values. */
export async function GET() {
  const core = getConfigStatus("core");
  const smtp = getConfigStatus("smtp");
  let database = false;
  if (core.ok) {
    try {
      const m = await connectDb();
      await m.connection.db?.admin().ping();
      database = true;
    } catch {
      database = false;
    }
  }
  const healthy = core.ok && database;
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks: { config: core.ok, database, email: smtp.ok } },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
