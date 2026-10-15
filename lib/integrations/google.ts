import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Minimal Google OAuth 2.0 (web server flow + PKCE) and Calendar v3 REST
 * client over fetch. Endpoints per Google's current documentation:
 *   auth   https://accounts.google.com/o/oauth2/v2/auth
 *   token  https://oauth2.googleapis.com/token
 *   revoke https://oauth2.googleapis.com/revoke
 *   API    https://www.googleapis.com/calendar/v3
 */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  // Create, update and delete the events RealtyPacer manages; also lists events for busy-time warnings.
  "https://www.googleapis.com/auth/calendar.events",
  // Lets the owner pick which calendar to use.
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
  /** The refresh token is no longer usable (revoked, expired, password change…). */
  get needsReauth() {
    return this.code === "invalid_grant" || this.code === "unauthorized_client";
  }
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizationUrl(p: { clientId: string; redirectUri: string; state: string; codeChallenge: string; loginHint?: string }) {
  const sp = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  });
  if (p.loginHint) sp.set("login_hint", p.loginHint);
  return `${AUTH_URL}?${sp}`;
}

async function form(url: string, body: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
  } catch {
    throw new GoogleApiError(0, "network", "Google could not be reached.");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new GoogleApiError(res.status, String(json.error ?? "error"), String(json.error_description ?? json.error ?? `HTTP ${res.status}`).slice(0, 200));
  return json;
}

export type TokenSet = { accessToken: string; expiresIn: number; refreshToken: string | null; scope: string; idToken: string | null };

export async function exchangeCode(p: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string }): Promise<TokenSet> {
  const j = await form(TOKEN_URL, { client_id: p.clientId, client_secret: p.clientSecret, code: p.code, grant_type: "authorization_code", redirect_uri: p.redirectUri, code_verifier: p.codeVerifier });
  return { accessToken: String(j.access_token), expiresIn: Number(j.expires_in ?? 3600), refreshToken: j.refresh_token ? String(j.refresh_token) : null, scope: String(j.scope ?? ""), idToken: j.id_token ? String(j.id_token) : null };
}

export async function refreshAccessToken(p: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ accessToken: string; expiresIn: number }> {
  const j = await form(TOKEN_URL, { client_id: p.clientId, client_secret: p.clientSecret, refresh_token: p.refreshToken, grant_type: "refresh_token" });
  return { accessToken: String(j.access_token), expiresIn: Number(j.expires_in ?? 3600) };
}

export async function revokeToken(token: string) {
  try {
    await form(REVOKE_URL, { token });
  } catch {
    /* already revoked or unreachable: local credentials are deleted anyway */
  }
}

/** Email claim from the ID token returned directly by Google's token endpoint over TLS. */
export function emailFromIdToken(idToken: string | null): string {
  if (!idToken) return "";
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1]!, "base64url").toString("utf8")) as { email?: string };
    return typeof payload.email === "string" ? payload.email.slice(0, 254) : "";
  } catch {
    return "";
  }
}

async function api<T>(accessToken: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new GoogleApiError(0, "network", "Google Calendar could not be reached.");
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as { error?: { code?: number; message?: string; status?: string; errors?: { reason?: string }[] } };
  if (!res.ok) {
    const reason = json.error?.errors?.[0]?.reason ?? json.error?.status ?? "error";
    throw new GoogleApiError(res.status, reason, (json.error?.message ?? `HTTP ${res.status}`).slice(0, 200));
  }
  return json as T;
}

export type GoogleCalendar = { id: string; summary: string; primary?: boolean; accessRole: string };
export type GoogleEvent = { id: string; status?: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; transparency?: string; extendedProperties?: { private?: Record<string, string> } };

export const calendarApi = {
  listCalendars: (t: string) => api<{ items?: GoogleCalendar[] }>(t, "GET", "/users/me/calendarList?minAccessRole=writer&maxResults=250"),
  insertEvent: (t: string, calendarId: string, event: Record<string, unknown>) => api<GoogleEvent>(t, "POST", `/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, event),
  patchEvent: (t: string, calendarId: string, eventId: string, event: Record<string, unknown>) => api<GoogleEvent>(t, "PATCH", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, event),
  deleteEvent: (t: string, calendarId: string, eventId: string) => api<void>(t, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`),
  getEvent: (t: string, calendarId: string, eventId: string) => api<GoogleEvent>(t, "GET", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`),
  listEvents: (t: string, calendarId: string, timeMin: string, timeMax: string) =>
    api<{ items?: GoogleEvent[] }>(t, "GET", `/calendars/${encodeURIComponent(calendarId)}/events?${new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "100" })}`),
};

/** Deterministic, valid Google event id for a booking (base32hex: a–v, 0–9). Makes creation idempotent. */
export function eventIdForBooking(bookingId: string): string {
  return `rp${bookingId.toLowerCase()}`;
}
