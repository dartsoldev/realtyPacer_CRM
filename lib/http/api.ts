import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError, type z } from "zod";
import { ConfigError } from "@/lib/env";
import { logger } from "@/lib/logger";
import { AppError, Errors } from "./errors";
import { assertSameOrigin, readJson } from "./request";

export type ApiErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId?: string };
};

const NO_STORE = { "Cache-Control": "private, no-store" };

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ data }, { status, headers: NO_STORE });
}

export function errorResponse(err: unknown): NextResponse<ApiErrorBody> {
  if (err instanceof AppError) {
    const headers: Record<string, string> = { ...NO_STORE };
    if (err.code === "RATE_LIMITED" && typeof err.details?.retryAfterSeconds === "number") {
      headers["Retry-After"] = String(err.details.retryAfterSeconds);
    }
    return NextResponse.json(
      { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
      { status: err.status, headers },
    );
  }
  if (err instanceof ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.join(".") || "_";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "Please correct the highlighted fields.", details: { fieldErrors } } },
      { status: 400, headers: NO_STORE },
    );
  }
  if (err instanceof ConfigError) {
    logger.error("config.incomplete", { issues: err.issues });
    return NextResponse.json(
      {
        error: {
          code: "SETUP_REQUIRED",
          message: "The server is not fully configured yet. An administrator must complete setup.",
          details: { issues: err.issues },
        },
      },
      { status: 503, headers: NO_STORE },
    );
  }
  const requestId = randomUUID();
  logger.error("api.unhandled_error", { requestId, error: err instanceof Error ? err : String(err) });
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again.", requestId } },
    { status: 500, headers: NO_STORE },
  );
}

type RouteContext<P> = { params: Promise<P> };

/**
 * Wraps a route handler with consistent error handling. Mutating methods get
 * the same-origin/JSON CSRF check automatically.
 */
export function route<P = Record<string, string>>(
  handler: (req: Request, ctx: RouteContext<P>) => Promise<Response>,
) {
  return async (req: Request, ctx: RouteContext<P>) => {
    try {
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) assertSameOrigin(req);
      return await handler(req, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  const body = await readJson(req);
  return schema.parse(body);
}

/** Raw JSON body (bounded size) for services that validate with their own shared schemas. */
export async function readBody(req: Request): Promise<unknown> {
  return readJson(req);
}

export function parseQuery<S extends z.ZodType>(req: Request, schema: S): z.infer<S> {
  const url = new URL(req.url);
  const raw: Record<string, string> = {};
  // Only the first value of each key; repeated keys can't smuggle arrays.
  for (const [k, v] of url.searchParams) if (!(k in raw)) raw[k] = v;
  return schema.parse(raw);
}

export { Errors };
