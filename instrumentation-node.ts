/** Node.js-only startup checks (imported from instrumentation.ts in the Node runtime). */
import { ConfigError, getCoreEnv, getStorageEnv, getTwilioEnv } from "@/lib/env";

export function validateStartupConfig() {
  try {
    getCoreEnv();
    getStorageEnv(); // optional, but if S3_BUCKET is set the rest must be valid
    getTwilioEnv(); // only checked when CALLING_MODE=browser
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(JSON.stringify({ level: "error", event: "startup.config_invalid", issues: err.issues, time: new Date().toISOString() }));
      process.exit(1);
    }
    throw err;
  }
}
