import { AppError } from "@/lib/http/errors";

export function tokenFailure(reason: "invalid" | "expired" | "used", what: string): AppError {
  switch (reason) {
    case "expired":
      return new AppError(410, "TOKEN_EXPIRED", `This ${what} has expired. Request a new one.`);
    case "used":
      return new AppError(410, "TOKEN_USED", `This ${what} has already been used.`);
    default:
      return new AppError(400, "TOKEN_INVALID", `This ${what} is not valid. Request a new one.`);
  }
}
