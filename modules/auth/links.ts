import "server-only";
import { getCoreEnv } from "@/lib/env";

/** Builds email links from the trusted APP_URL — never from the request Host. */
export function appLink(path: string, params?: Record<string, string>): string {
  const url = new URL(path, getCoreEnv().APP_URL);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}
