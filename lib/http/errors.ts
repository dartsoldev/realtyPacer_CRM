/**
 * Typed application errors. Messages are safe to show to the caller; anything
 * unexpected becomes a generic 500 with a correlation id.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  unauthenticated: () => new AppError(401, "UNAUTHENTICATED", "Please sign in to continue."),
  forbidden: (message = "You do not have permission to perform this action.") => new AppError(403, "FORBIDDEN", message),
  notFound: (what = "Record") => new AppError(404, "NOT_FOUND", `${what} not found.`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  validation: (message: string, fieldErrors?: Record<string, string[]>) =>
    new AppError(400, "VALIDATION_ERROR", message, fieldErrors ? { fieldErrors } : undefined),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.", { retryAfterSeconds }),
  badOrigin: () => new AppError(403, "BAD_ORIGIN", "Request origin not allowed."),
  emailDelivery: (details?: Record<string, unknown>) =>
    new AppError(502, "EMAIL_DELIVERY_FAILED", "The email could not be sent. Nothing was delivered; please retry.", details),
};
