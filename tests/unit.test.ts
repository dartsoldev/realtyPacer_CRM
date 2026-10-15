import { describe, expect, it } from "vitest";
import { findLineItemOverAllocations, validatePaymentAllocations } from "@/lib/domain/allocations";
import { formatCents, parseAmountToCents } from "@/lib/domain/money";
import { escapeRegex, normalizeEmail, normalizePhone } from "@/lib/domain/normalize";
import { assignableRoles, canManageRole, hasPermission, permissionsFor } from "@/lib/permissions/matrix";
import { maskEmail, redact } from "@/lib/security/redact";
import { safeCallbackPath } from "@/lib/site";
import { contextualPasswordProblem, hashPassword, passwordSchema, verifyPassword } from "@/lib/auth/password";

describe("permission matrix", () => {
  it("gives SUPERADMIN everything and limits ADMIN", () => {
    expect(hasPermission("SUPERADMIN", [], "audit:read")).toBe(true);
    expect(hasPermission("ADMIN", [], "audit:read")).toBe(false);
    expect(hasPermission("ADMIN", [], "organization:update_protected")).toBe(false);
    expect(hasPermission("ADMIN", [], "users:invite")).toBe(true);
  });
  it("prevents ADMIN from granting or managing privileged roles", () => {
    expect(assignableRoles("ADMIN")).toEqual(["STAFF", "CLEANER"]);
    expect(canManageRole("ADMIN", "SUPERADMIN")).toBe(false);
    expect(canManageRole("ADMIN", "ADMIN")).toBe(false);
    expect(assignableRoles("STAFF")).toEqual([]);
  });
  it("only applies allowlisted STAFF grants", () => {
    const p = permissionsFor("STAFF", ["payments:read", "users:manage", "audit:read"]);
    expect(p.has("payments:read")).toBe(true);
    expect(p.has("users:manage")).toBe(false);
    expect(p.has("audit:read")).toBe(false);
    expect(permissionsFor("ADMIN", ["audit:read"]).has("audit:read")).toBe(false);
  });
  it("keeps CLEANER away from customer lists and finance", () => {
    const p = permissionsFor("CLEANER");
    for (const perm of ["customers:read", "payments:read", "reports:read", "bookings:read"] as const) expect(p.has(perm)).toBe(false);
    expect(p.has("bookings:read_assigned")).toBe(true);
  });
});

describe("payment allocations", () => {
  it("rejects over-allocation, duplicates and non-integer cents", () => {
    const issues = validatePaymentAllocations(1000, [
      { bookingId: "b", lineItemId: "l1", amountCents: 700 },
      { bookingId: "b", lineItemId: "l1", amountCents: 400 },
      { bookingId: "b", lineItemId: "l2", amountCents: 1.5 },
    ]);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("DUPLICATE_LINE_ITEM");
    expect(codes).toContain("EXCEEDS_PAYMENT_AMOUNT");
    expect(codes).toContain("NON_INTEGER_AMOUNT");
    expect(validatePaymentAllocations(1000, [{ bookingId: "b", lineItemId: "l", amountCents: 1000 }])).toEqual([]);
  });
  it("detects line items pushed over their total across payments", () => {
    const capacities = [{ bookingId: "b", lineItemId: "l", lineTotalCents: 5000, alreadyAllocatedCents: 4000 }];
    expect(findLineItemOverAllocations([{ bookingId: "b", lineItemId: "l", amountCents: 1000 }], capacities)).toEqual([]);
    expect(findLineItemOverAllocations([{ bookingId: "b", lineItemId: "l", amountCents: 1001 }], capacities)).toHaveLength(1);
    expect(findLineItemOverAllocations([{ bookingId: "x", lineItemId: "y", amountCents: 1 }], capacities)).toHaveLength(1);
  });
});

describe("normalisation and money", () => {
  it("normalises emails and phones", () => {
    expect(normalizeEmail("  Jane.Doe@Example.COM ")).toBe("jane.doe@example.com");
    expect(normalizePhone("(514) 555-0100")).toBe("+15145550100");
    expect(normalizePhone("+44 20 7946 0000")).toBe("+442079460000");
    expect(normalizePhone("123")).toBeNull();
  });
  it("handles cents exactly", () => {
    expect(parseAmountToCents("12.5")).toBe(1250);
    expect(parseAmountToCents("1,234.07")).toBe(123407);
    expect(parseAmountToCents("1.234")).toBeNull();
    expect(formatCents(123407, "CAD")).toContain("1,234.07");
  });
  it("escapes regex input", () => {
    expect(new RegExp(escapeRegex("a.*(b")).test("a.*(b")).toBe(true);
    expect(new RegExp(escapeRegex("a.*")).test("abc")).toBe(false);
  });
});

describe("redaction and redirects", () => {
  it("removes secrets and masks emails", () => {
    const out = redact({ password: "hunter2", nested: { smtpPassword: "x", note: "contact jane@example.com" }, uri: "mongodb+srv://u:p@host/db" }) as Record<string, unknown>;
    expect(out.password).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).smtpPassword).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("jane@example.com");
    expect(JSON.stringify(out)).not.toContain("u:p");
    expect(maskEmail("jane@example.com")).toBe("j***@example.com");
  });
  it("only allows same-site relative callback paths", () => {
    expect(safeCallbackPath("/dashboard/users?page=2")).toBe("/dashboard/users?page=2");
    for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "", null]) {
      expect(safeCallbackPath(bad)).toBe("/dashboard");
    }
  });
});

describe("password hashing and policy", () => {
  it("uses argon2id and verifies", async () => {
    const h = await hashPassword("a long enough passphrase");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "a long enough passphrase")).toBe(true);
    expect(await verifyPassword(h, "wrong passphrase here")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
  it("enforces length and context rules", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("x".repeat(129)).success).toBe(false);
    expect(passwordSchema.safeParse("aaaaaaaaaaaaaaaa").success).toBe(false);
    expect(passwordSchema.safeParse("maple syrup on snow").success).toBe(true);
    expect(contextualPasswordProblem("janedoe-is-great-2026", { email: "janedoe@example.com" })).not.toBeNull();
  });
});
