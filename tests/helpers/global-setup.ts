import { randomBytes } from "node:crypto";
import type { TestProject } from "vitest/node";

/**
 * Test database:
 *  - default: an in-memory single-node replica set (mongodb-memory-server; downloads a binary once)
 *  - TEST_MONGODB_URI set: a throwaway database named `realtypacer_test_<random>`
 *    on that server, dropped in teardown. The database name in the URI is
 *    always replaced, so an application database can never be used.
 */
let stopMemory: (() => Promise<unknown>) | undefined;
let dropRemote: (() => Promise<void>) | undefined;

function withDatabase(uri: string, db: string): string {
  const url = new URL(uri);
  url.pathname = `/${db}`;
  return url.toString();
}

export async function setup(project: TestProject) {
  const external = process.env.TEST_MONGODB_URI;
  if (external) {
    const db = `realtypacer_test_${randomBytes(4).toString("hex")}`;
    const uri = withDatabase(external, db);
    project.provide("mongoUri", uri);
    dropRemote = async () => {
      const { default: mongoose } = await import("mongoose");
      const conn = await mongoose.createConnection(uri).asPromise();
      if (!conn.name.startsWith("realtypacer_test_")) throw new Error("refusing to drop a non-test database");
      await conn.dropDatabase();
      await conn.close();
    };
    console.info(`[tests] using throwaway database ${db} on TEST_MONGODB_URI`);
    return;
  }
  // Replica set: booking scheduling relies on multi-document transactions.
  const { MongoMemoryReplSet } = await import("mongodb-memory-server");
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  stopMemory = () => mongo.stop();
  project.provide("mongoUri", withDatabase(mongo.getUri(), "realtypacer-test"));
}

export async function teardown() {
  await dropRemote?.();
  await stopMemory?.();
}

declare module "vitest" {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
