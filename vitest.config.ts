import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // `server-only` throws outside the React Server Components bundler; the
      // modules under test are server modules, so stub it for Node tests.
      "server-only": path.resolve(__dirname, "tests/helpers/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/helpers/global-setup.ts"],
    setupFiles: ["tests/helpers/setup.ts"],
    // Remote test databases (TEST_MONGODB_URI) add network latency to every transaction.
    testTimeout: process.env.TEST_MONGODB_URI ? 240_000 : 30_000,
    hookTimeout: 120_000,
    // Tests share one in-memory MongoDB; run files sequentially for isolation.
    fileParallelism: false,
  },
});
