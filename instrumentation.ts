/**
 * Runs once when a server instance starts. In production the required
 * configuration is validated up front: a misconfigured container fails to
 * start (and its health check fails) instead of serving broken pages.
 * Only variable names are reported, never values.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { validateStartupConfig } = await import("./instrumentation-node");
  validateStartupConfig();
}
