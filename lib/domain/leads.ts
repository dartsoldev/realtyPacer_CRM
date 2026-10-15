/** Lead constants and labels (shared by server and browser code). */
export const LEAD_CATEGORIES = ["general", "real_estate"] as const;
export type LeadCategory = (typeof LEAD_CATEGORIES)[number];
export const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const RE_INTENTS = ["buyer", "seller", "renter", "other"] as const;
export type ReIntent = (typeof RE_INTENTS)[number];
/** How the lead arrived (separate from its category). */
export const LEAD_CHANNELS = ["manual", "csv_import", "intake"] as const;

export const LEAD_CATEGORY_LABELS: Record<LeadCategory, string> = { general: "General / service", real_estate: "Real estate" };
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = { new: "New", contacted: "Contacted", qualified: "Qualified", converted: "Converted", lost: "Lost" };
export const RE_INTENT_LABELS: Record<ReIntent, string> = { buyer: "Buyer", seller: "Seller", renter: "Renter", other: "Other" };
export const LEAD_CHANNEL_LABELS: Record<(typeof LEAD_CHANNELS)[number], string> = { manual: "Entered manually", csv_import: "CSV import", intake: "Website form" };
