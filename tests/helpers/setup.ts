import { afterAll, beforeEach, inject } from "vitest";

// Isolated test configuration — never real services.
process.env.MONGODB_URI = inject("mongoUri");
process.env.APP_URL = "http://localhost:3000";
process.env.NEXTAUTH_URL = "http://localhost:3000";
process.env.NEXTAUTH_SECRET = "test-secret-test-secret-test-secret-0123456789";
process.env.TRUST_PROXY_HEADERS = "false";
for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM"]) delete process.env[k];

beforeEach(async () => {
  const { connectDb } = await import("@/lib/db/connect");
  const m = await connectDb();
  const name = m.connection.name;
  if (!/^realtypacer[-_]test/.test(name)) throw new Error(`Refusing to reset non-test database "${name}"`);
  const { ALL_MODELS } = await import("@/lib/db/models");
  if (!indexesReady) {
    await Promise.all(ALL_MODELS.map((model) => model.init()));
    indexesReady = true;
  }
  // Clear documents but keep indexes (fast on remote test databases).
  await Promise.all(ALL_MODELS.map((model) => model.collection.deleteMany({})));
});

let indexesReady = false;

afterAll(async () => {
  const { disconnectDb } = await import("@/lib/db/connect");
  await disconnectDb();
});
