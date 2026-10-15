import "server-only";

export { Organization } from "./organization";
export { User } from "./user";
export { Customer } from "./customer";
export { ServiceAddress } from "./service-address";
export { Service } from "./service";
export { Cleaner } from "./cleaner";
export { Booking } from "./booking";
export { Payment } from "./payment";
export { CustomFieldDefinition } from "./custom-field";
export { LoyaltyEntry } from "./loyalty-entry";
export { AuthToken } from "./auth-token";
export { AuditEvent } from "./audit-event";
export { RateLimit } from "./rate-limit";
export { Activity } from "./activity";

import { Organization } from "./organization";
import { User } from "./user";
import { Customer } from "./customer";
import { ServiceAddress } from "./service-address";
import { Service } from "./service";
import { Cleaner } from "./cleaner";
import { Booking } from "./booking";
import { Payment } from "./payment";
import { CustomFieldDefinition } from "./custom-field";
import { LoyaltyEntry } from "./loyalty-entry";
import { AuthToken } from "./auth-token";
import { AuditEvent } from "./audit-event";
import { RateLimit } from "./rate-limit";
import { Activity } from "./activity";

export const ALL_MODELS = [
  Organization,
  User,
  Customer,
  ServiceAddress,
  Service,
  Cleaner,
  Booking,
  Payment,
  CustomFieldDefinition,
  LoyaltyEntry,
  AuthToken,
  AuditEvent,
  RateLimit,
  Activity,
] as const;
