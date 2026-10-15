/**
 * Loads .env.local / .env for CLI scripts (Next.js does this itself for the app).
 * Existing process env vars always win.
 */
import { existsSync } from "node:fs";
import path from "node:path";

for (const file of [".env.local", ".env"]) {
  const full = path.resolve(process.cwd(), file);
  if (existsSync(full)) process.loadEnvFile(full);
}
