"use client";

export type ApiFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
  details?: Record<string, unknown>;
};
export type ApiSuccess<T> = { ok: true; data: T };

/**
 * Same-origin JSON client for /api/v1. Cookies are HttpOnly and sent by the
 * browser; nothing auth-related is stored in localStorage.
 */
export async function apiRequest<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<ApiSuccess<T> | ApiFailure> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: init.body === undefined ? (init.method && init.method !== "GET" ? "{}" : undefined) : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") return { ok: false, status: 0, code: "ABORTED", message: "Request cancelled." };
    return { ok: false, status: 0, code: "NETWORK_ERROR", message: "Network error. Check your connection and try again." };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  if (res.ok) return { ok: true, data: (json as { data: T }).data };
  const err = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
  return {
    ok: false,
    status: res.status,
    code: err?.code ?? "UNKNOWN",
    message: err?.message ?? "Something went wrong. Please try again.",
    fieldErrors: err?.details?.fieldErrors as Record<string, string[]> | undefined,
    details: err?.details,
  };
}
