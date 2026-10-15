/**
 * Shared domain enums. Safe to import from both server and client code.
 */
export const ROLES = ["SUPERADMIN", "ADMIN", "STAFF", "CLEANER"] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ["invited", "active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const BOOKING_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/** Statuses that occupy a cleaner's time (cancelled and completed jobs don't block new work). */
export const BLOCKING_BOOKING_STATUSES = ["SCHEDULED", "IN_PROGRESS"] as const;

export const CUSTOMER_TYPES = ["individual", "business", "referral_partner", "other"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
export const CUSTOMER_TYPE_LABELS: Record<CustomerType, string> = {
  individual: "Individual",
  business: "Business",
  referral_partner: "Realtor / referral partner",
  other: "Other",
};

export const CONTACT_SOURCES = ["referral", "website", "phone", "social_media", "repeat", "realtor", "other"] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];
export const CONTACT_SOURCE_LABELS: Record<ContactSource, string> = {
  referral: "Referral",
  website: "Website",
  phone: "Phone call",
  social_media: "Social media",
  repeat: "Returning customer",
  realtor: "Realtor / partner",
  other: "Other",
};

export const ACTIVITY_TYPES = [
  "customer.created",
  "customer.updated",
  "customer.archived",
  "customer.unarchived",
  "address.added",
  "address.updated",
  "address.archived",
  "booking.created",
  "booking.updated",
  "booking.rescheduled",
  "booking.address_changed",
  "booking.assignment_changed",
  "booking.started",
  "booking.completed",
  "booking.cancelled",
  "booking.reopened",
  "note",
  "call",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const CALL_OUTCOMES = ["answered", "no_answer", "voicemail", "callback_requested", "wrong_number"] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  answered: "Answered",
  no_answer: "No answer",
  voicemail: "Left voicemail",
  callback_requested: "Callback requested",
  wrong_number: "Wrong number",
};

/** Service-item rules (see PROJECT_STATE.md → "Date, count and amount definitions"). */
export const MAX_LINE_QUANTITY = 1000;
export const MAX_UNIT_PRICE_CENTS = 10_000_000; // $100,000.00
export const MAX_BOOKING_MINUTES = 24 * 60;
export const MAX_LINE_ITEMS = 50;

export const PAYMENT_METHODS = ["cash", "card", "e_transfer", "cheque", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ["pending", "completed", "failed", "refunded", "voided"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const CUSTOM_FIELD_ENTITIES = ["customer", "booking", "service_address"] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const CUSTOM_FIELD_TYPES = ["text", "number", "date", "boolean", "select", "multi_select"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const AUTH_TOKEN_PURPOSES = ["invitation", "email_verification", "password_reset"] as const;
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  SUPERADMIN: "Superadmin",
  ADMIN: "Admin",
  STAFF: "Staff",
  CLEANER: "Cleaner",
};

export const STATUS_LABELS: Record<UserStatus, string> = {
  invited: "Invited",
  active: "Active",
  suspended: "Suspended",
};

/** Password policy: long passphrases encouraged, bounded to protect the hasher. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const DEFAULT_TIMEZONE = "America/Toronto";
export const DEFAULT_CURRENCY = "CAD";
