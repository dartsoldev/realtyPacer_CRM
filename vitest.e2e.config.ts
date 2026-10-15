import path from "node:path";
import { defineConfig } from "vitest/config";

/** End-to-end suite: production build over HTTP. Run `npm run build && npm run build:cli` first. */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname), "server-only": path.resolve(__dirname, "tests/helpers/server-only-stub.ts") } },
  test: {
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
