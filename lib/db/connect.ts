import "server-only";
import mongoose from "mongoose";
import { getCoreEnv } from "@/lib/env";

// Unknown filter paths are dropped instead of passed through to MongoDB.
mongoose.set("strictQuery", true);

type Cache = { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null };

const globalForMongoose = globalThis as unknown as { __realtypacerMongoose?: Cache };
const cache: Cache = globalForMongoose.__realtypacerMongoose ?? { conn: null, promise: null };
globalForMongoose.__realtypacerMongoose = cache;

/**
 * Cached connection: survives hot reloads in development and is reused across
 * invocations of a warm serverless/Node process in production.
 */
export async function connectDb(): Promise<typeof mongoose> {
  if (cache.conn && mongoose.connection.readyState === 1) return cache.conn;
  if (!cache.promise) {
    const { MONGODB_URI } = getCoreEnv();
    // A URI without a database path would silently use "test"; default to "realtypacer".
    const hasDbName = new URL(MONGODB_URI).pathname.replace(/^\//, "").length > 0;
    cache.promise = mongoose
      .connect(MONGODB_URI, {
        ...(hasDbName ? {} : { dbName: "realtypacer" }),
        bufferCommands: false,
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 10_000,
        // Indexes are created explicitly with `npm run db:indexes`.
        autoIndex: process.env.NODE_ENV !== "production",
      })
      .catch((err) => {
        cache.promise = null;
        throw err;
      });
  }
  cache.conn = await cache.promise;
  return cache.conn;
}

export async function disconnectDb() {
  await mongoose.disconnect();
  cache.conn = null;
  cache.promise = null;
}
