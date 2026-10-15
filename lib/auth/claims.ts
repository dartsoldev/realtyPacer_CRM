import "server-only";
import { getServerSession } from "next-auth";
import { getAuthOptions } from "./options";

export type SessionClaims = { userId: string; organizationId: string; sessionVersion: number };

/**
 * Reads and decrypts the session cookie. Returns the *claims* only — callers
 * must go through getCurrentUser() to validate them against the database.
 */
export async function getSessionClaims(): Promise<SessionClaims | null> {
  const session = await getServerSession(getAuthOptions());
  if (!session?.user?.id || !session.oid || typeof session.sv !== "number" || session.sv < 0) return null;
  return { userId: session.user.id, organizationId: session.oid, sessionVersion: session.sv };
}
