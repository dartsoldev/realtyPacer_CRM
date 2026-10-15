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
export { Refund } from "./refund";
export { ChargeAdjustment } from "./charge-adjustment";
export { SavedView } from "./saved-view";
export { CallLog } from "./call-log";
export { OutboxMessage } from "./outbox-message";
export { Notification } from "./notification";
export { WorkerHeartbeat } from "./worker-heartbeat";
export { Attachment } from "./attachment";
export { ImportJob } from "./import-job";
export { GoogleCalendarConnection } from "./google-calendar";
export { OAuthState } from "./google-calendar";
export { CalendarSync } from "./google-calendar";
export { Lead } from "./lead";
export { LeadSource } from "./lead";
export { LeadSubmissionLog } from "./lead";

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
import { Refund } from "./refund";
import { ChargeAdjustment } from "./charge-adjustment";
import { SavedView } from "./saved-view";
import { CallLog } from "./call-log";
import { OutboxMessage } from "./outbox-message";
import { Notification } from "./notification";
import { WorkerHeartbeat } from "./worker-heartbeat";
import { Attachment } from "./attachment";
import { ImportJob } from "./import-job";
import { GoogleCalendarConnection } from "./google-calendar";
import { OAuthState } from "./google-calendar";
import { CalendarSync } from "./google-calendar";
import { Lead } from "./lead";
import { LeadSource } from "./lead";
import { LeadSubmissionLog } from "./lead";

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
  Refund,
  ChargeAdjustment,
  SavedView,
  CallLog,
  OutboxMessage,
  Notification,
  WorkerHeartbeat,
  Attachment,
  ImportJob,
  GoogleCalendarConnection,
  OAuthState,
  CalendarSync,
  Lead,
  LeadSource,
  LeadSubmissionLog,
] as const;
