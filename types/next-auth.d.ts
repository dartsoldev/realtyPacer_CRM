import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: { id: string; name: string | null; email: string | null };
    /** Organization id at sign-in time (re-verified server-side). */
    oid: string;
    /** sessionVersion at sign-in time; compared with the user's current value. */
    sv: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    oid?: string;
    sv?: number;
  }
}
