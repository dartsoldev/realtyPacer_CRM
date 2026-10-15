/**
 * Bundles the operational CLIs (worker, index migration, superadmin bootstrap,
 * dev fixtures) into dist/*.cjs for the production image, so the runtime needs
 * no TypeScript tooling. Native/large packages stay external (installed with
 * `npm ci --omit=dev` in the worker/ops image).
 */
import { build } from "esbuild";

const entries = { worker: "scripts/worker.ts", "sync-indexes": "scripts/sync-indexes.ts", migrate: "scripts/migrate.ts", "bootstrap-superadmin": "scripts/bootstrap-superadmin.ts" };
await build({
  entryPoints: entries,
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  conditions: ["react-server"],
  external: ["mongoose", "mongodb", "nodemailer", "twilio", "sharp", "@node-rs/argon2", "@aws-sdk/*", "libphonenumber-js", "zod"],
  sourcemap: true,
  logLevel: "info",
});
