/**
 * Customer and address validation shared by the API (authoritative) and the
 * client forms (inline feedback). No server-only imports.
 */
import { z } from "zod";
import { CONTACT_SOURCES, CUSTOMER_TYPES } from "@/lib/domain/constants";
import { isSafeHttpUrl } from "@/lib/domain/links";
import { OBJECT_ID_RE } from "@/lib/domain/normalize";
import { isDateKey } from "@/lib/domain/zoned-time";

export const objectId = z.string().regex(OBJECT_ID_RE, "Invalid id");
export const dateKey = z.string().refine(isDateKey, "Use a valid date (YYYY-MM-DD)");
const text = (max: number) => z.string().trim().max(max);

export const linkSchema = z.object({
  label: text(80).min(1, "Give the link a label"),
  url: text(2000).refine(isSafeHttpUrl, "Only http(s) links are allowed"),
});

export const addressInputSchema = z
  .object({
    label: text(80).default(""),
    line1: text(200).min(1, "Street address is required"),
    line2: text(200).default(""),
    city: text(100).min(1, "City is required"),
    region: text(100).default(""),
    postalCode: text(20).default(""),
    country: text(100).default("Canada"),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    accessInstructions: text(2000).default(""),
    isPrimary: z.boolean().default(false),
    links: z.array(linkSchema).max(5).default([]),
  })
  .strict()
  .refine((a) => (a.lat == null) === (a.lng == null), { message: "Provide both latitude and longitude, or neither", path: ["lat"] });

export type AddressInput = z.infer<typeof addressInputSchema>;

const tagsSchema = z
  .array(text(30).min(1))
  .max(20, "Use at most 20 tags")
  .default([])
  .transform((tags) => {
    const seen = new Set<string>();
    return tags.filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });

export const customerFieldsSchema = z.object({
  customerType: z.enum(CUSTOMER_TYPES).default("individual"),
  firstName: text(80).default(""),
  lastName: text(80).default(""),
  /** Business / display name (required when not an individual). */
  displayName: text(160).default(""),
  companyName: text(160).default(""),
  phone: text(40).default(""),
  /** ISO country used to interpret numbers without "+"; defaults to Canada. */
  phoneCountry: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default("CA"),
  email: z.union([z.literal(""), text(254).email("Enter a valid email or leave it blank")]).default(""),
  relationshipStartedAt: z.union([z.literal(""), dateKey]).default(""),
  contactSource: z.union([z.literal(""), z.enum(CONTACT_SOURCES)]).default(""),
  tags: tagsSchema,
  notes: text(5000).default(""),
  /** Values for customer custom fields; validated server-side against the definitions. */
  customFields: z.record(z.string(), z.unknown()).optional(),
});

/** Name + contact rules shared by create and update. */
function checkNameAndContact(c: z.infer<typeof customerFieldsSchema>, ctx: z.RefinementCtx) {
  const hasName = c.customerType === "individual" ? `${c.firstName}${c.lastName}`.trim().length > 0 : (c.displayName || c.companyName).trim().length > 0;
  if (!hasName) ctx.addIssue({ code: "custom", message: "Enter a name", path: [c.customerType === "individual" ? "firstName" : "displayName"] });
  if (!c.phone.trim() && !c.email.trim()) ctx.addIssue({ code: "custom", message: "Add a phone number or an email address", path: ["phone"] });
}

export const createCustomerSchema = customerFieldsSchema
  .extend({
    primaryAddress: addressInputSchema.optional(),
    /** Set after the user has seen possible duplicates and chosen to continue. */
    confirmDuplicate: z.boolean().default(false),
  })
  .strict()
  .superRefine(checkNameAndContact);

export const updateCustomerSchema = customerFieldsSchema.strict().superRefine(checkNameAndContact);

export type CustomerFields = z.infer<typeof customerFieldsSchema>;

export function displayNameOf(c: Pick<CustomerFields, "customerType" | "firstName" | "lastName" | "displayName" | "companyName">): string {
  if (c.customerType === "individual") return `${c.firstName} ${c.lastName}`.replace(/\s+/g, " ").trim();
  return (c.displayName || c.companyName).trim();
}

export const CUSTOMER_SORTS = ["name", "createdAt", "relationshipStartedAt", "updatedAt"] as const;
export const CUSTOMER_COLUMNS = ["phone", "email", "city", "tags", "type", "since", "created"] as const;
export type CustomerColumn = (typeof CUSTOMER_COLUMNS)[number];
export const DEFAULT_CUSTOMER_COLUMNS: CustomerColumn[] = ["phone", "email", "city", "tags"];

export const customerListQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: text(100).optional(),
  city: text(100).optional(),
  tag: text(30).optional(),
  status: z.enum(["active", "archived", "all"]).default("active"),
  sort: z.enum(CUSTOMER_SORTS).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  /** Encoded advanced filter conditions (same engine as reports, customer fields only). */
  f: z.string().max(8000).optional(),
});
