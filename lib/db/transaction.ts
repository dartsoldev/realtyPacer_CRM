import "server-only";
import type { ClientSession } from "mongoose";
import { AppError } from "@/lib/http/errors";
import { connectDb } from "./connect";

export const MAX_TRANSACTION_ATTEMPTS = 5;

function hasLabel(err: unknown, label: string): boolean {
  const e = err as { hasErrorLabel?: (l: string) => boolean; errorLabels?: string[]; errorLabelSet?: Set<string> };
  return Boolean(e?.hasErrorLabel?.(label) || e?.errorLabels?.includes(label) || e?.errorLabelSet?.has(label));
}

export function isTransientTransactionError(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return hasLabel(err, "TransientTransactionError") || code === 112 /* WriteConflict */ || code === 251 /* NoSuchTransaction */;
}

/**
 * Runs `fn` in a MongoDB transaction (snapshot read, majority write) with a
 * bounded number of retries for transient conflicts. Requires a replica set
 * (MongoDB Atlas, or a local replica set in tests). AppErrors thrown by `fn`
 * abort the transaction and propagate unchanged.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>, maxAttempts = MAX_TRANSACTION_ATTEMPTS): Promise<T> {
  const mongoose = await connectDb();
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      const result = await fn(session);
      for (let commitTry = 0; ; commitTry++) {
        try {
          await session.commitTransaction();
          break;
        } catch (err) {
          if (hasLabel(err, "UnknownTransactionCommitResult") && commitTry < 3) continue;
          throw err;
        }
      }
      return result;
    } catch (err) {
      lastError = err;
      if (session.inTransaction()) await session.abortTransaction().catch(() => undefined);
      if (err instanceof AppError || !isTransientTransactionError(err)) throw err;
      // Jittered backoff before retrying a write conflict.
      await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 40));
    } finally {
      await session.endSession();
    }
  }
  void lastError;
  throw new AppError(409, "BUSY_RETRY", "Several people changed this schedule at the same moment. Please try again.");
}
