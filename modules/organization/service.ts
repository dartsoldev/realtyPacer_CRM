import "server-only";
import { z } from "zod";
import type { CurrentUser } from "@/lib/auth/current-user";
import { connectDb } from "@/lib/db/connect";
import { Organization } from "@/lib/db/models/organization";
import { isValidTimeZone } from "@/lib/domain/time";
import { Errors } from "@/lib/http/errors";
import { PROTECTED_ORGANIZATION_FIELDS } from "@/lib/permissions/matrix";
import { recordAudit } from "@/modules/audit/service";

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

export const organizationUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().refine(isValidTimeZone, "Unknown timezone").optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "Use a 3-letter ISO currency code")
      .optional(),
    contact: z
      .object({
        email: z.union([z.literal(""), z.string().trim().email().max(254)]).optional().default(""),
        phone: optionalText(40),
        website: z
          .union([z.literal(""), z.string().trim().url().max(200).refine((u) => /^https?:\/\//i.test(u), "Use an http(s) URL")])
          .optional()
          .default(""),
        addressLine1: optionalText(200),
        city: optionalText(100),
        region: optionalText(100),
        postalCode: optionalText(20),
        country: optionalText(100),
        serviceArea: optionalText(200),
      })
      .strict()
      .optional(),
    terminology: z
      .object({
        customer: z.string().trim().min(1).max(40),
        booking: z.string().trim().min(1).max(40),
        provider: z.string().trim().min(1).max(40),
      })
      .strict()
      .optional(),
    notifications: z.object({ customerBookingEmails: z.enum(["off", "manual", "auto"]) }).strict().optional(),
    /** Explicit, superadmin-only. Snapshotted onto bookings when charges are finalized. */
    tax: z
      .object({
        enabled: z.boolean(),
        rateBasisPoints: z.number().int().min(0).max(10_000),
        label: z.string().trim().max(40).default(""),
      })
      .strict()
      .refine((t) => !t.enabled || (t.rateBasisPoints > 0 && t.label.length > 0), { message: "Enter a tax name and a rate above 0, or turn tax off" })
      .optional(),
  })
  .strict();

export type OrganizationSettings = {
  id: string;
  name: string;
  displayName: string;
  timezone: string;
  currency: string;
  contact: Record<string, string>;
  terminology: { customer: string; booking: string; provider: string };
  tax: { enabled: boolean; rateBasisPoints: number; label: string };
  notifications: { customerBookingEmails: "off" | "manual" | "auto" };
  updatedAt: string;
};

function toSettings(org: Record<string, unknown> & { _id: unknown; updatedAt?: Date }): OrganizationSettings {
  const contact = (org.contact ?? {}) as Record<string, string | undefined>;
  const terminology = (org.terminology ?? {}) as Record<string, string | undefined>;
  const tax = (org.tax ?? {}) as { enabled?: boolean; rateBasisPoints?: number; label?: string };
  const notifications = (org.notifications ?? {}) as { customerBookingEmails?: "off" | "manual" | "auto" };
  return {
    notifications: { customerBookingEmails: notifications.customerBookingEmails ?? "off" },
    tax: { enabled: Boolean(tax.enabled), rateBasisPoints: tax.rateBasisPoints ?? 0, label: tax.label ?? "" },
    id: String(org._id),
    name: String(org.name),
    displayName: String(org.displayName),
    timezone: String(org.timezone),
    currency: String(org.currency),
    contact: Object.fromEntries(
      ["email", "phone", "website", "addressLine1", "city", "region", "postalCode", "country", "serviceArea"].map((k) => [k, contact[k] ?? ""]),
    ),
    terminology: {
      customer: terminology.customer ?? "Customer",
      booking: terminology.booking ?? "Booking",
      provider: terminology.provider ?? "Cleaner",
    },
    updatedAt: org.updatedAt ? org.updatedAt.toISOString() : new Date(0).toISOString(),
  };
}

export async function getOrganizationSettings(actor: CurrentUser): Promise<OrganizationSettings> {
  if (!actor.permissions.has("organization:read")) throw Errors.forbidden();
  await connectDb();
  const org = await Organization.findById(actor.organizationId).lean();
  if (!org) throw Errors.notFound("Organization");
  return toSettings(org as never);
}

export async function updateOrganizationSettings(actor: CurrentUser, input: z.infer<typeof organizationUpdateSchema>) {
  if (!actor.permissions.has("organization:update")) throw Errors.forbidden();
  await connectDb();
  const org = await Organization.findById(actor.organizationId).lean();
  if (!org) throw Errors.notFound("Organization");

  const changingProtected: string[] = PROTECTED_ORGANIZATION_FIELDS.filter(
    (f) => input[f] !== undefined && input[f] !== (org as Record<string, unknown>)[f],
  );
  if (input.tax !== undefined) changingProtected.push("tax");
  if (changingProtected.length > 0 && !actor.permissions.has("organization:update_protected")) {
    throw Errors.forbidden(`Only a superadmin can change: ${changingProtected.join(", ")}.`);
  }

  // Explicit allowlist of writable paths (no mass assignment).
  const set: Record<string, unknown> = {};
  for (const f of ["name", "displayName", "timezone", "currency"] as const) if (input[f] !== undefined) set[f] = input[f];
  if (input.contact) for (const [k, v] of Object.entries(input.contact)) set[`contact.${k}`] = v;
  if (input.terminology) for (const [k, v] of Object.entries(input.terminology)) set[`terminology.${k}`] = v;
  if (input.notifications) set["notifications.customerBookingEmails"] = input.notifications.customerBookingEmails;
  if (input.tax) set.tax = input.tax.enabled ? input.tax : { enabled: false, rateBasisPoints: 0, label: "" };

  const updated = await Organization.findByIdAndUpdate(actor.organizationId, { $set: set }, { returnDocument: "after", runValidators: true }).lean();
  await recordAudit({
    organizationId: actor.organizationId,
    actorId: actor.id,
    action: "organization.updated",
    entityType: "organization",
    entityId: actor.organizationId,
    metadata: { fields: Object.keys(set) },
  });
  return toSettings(updated as never);
}
