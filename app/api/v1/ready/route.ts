import { NextResponse } from "next/server";
import { pingDatabase } from "@/lib/diagnostics";
import { getConfigStatus } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Readiness for load balancers / orchestrators: 200 only when required
 * configuration is valid and the database answers. No details are exposed.
 */
export async function GET() {
  const ready = getConfigStatus("core").ok && (await pingDatabase()).ok;
  return NextResponse.json({ status: ready ? "ready" : "not_ready" }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
