# PROJECT_STATE — RealtyPacer

_Last updated: 2026-10-15 · Phases 1–2 of 4 complete (see "Checks" for exactly what was verified)._

Core relationship: **Customer → Service address → Booking → Service items → Assigned cleaners.**

## Architectural decisions

| Decision | Choice and reason |
|---|---|
| Framework | Next.js 16.4.1 App Router, Node runtime for all DB/auth/SMTP code. No separate Express server; business logic lives in `modules/*` so it can be extracted later. Route handlers are thin. |
| Auth library | **next-auth 4.24.15** (stable; peer-supports Next 16). Auth.js v5 is still beta and is not used. Only v4 APIs appear. |
| Session strategy | JWT in encrypted HttpOnly cookie (SameSite=Lax, `__Secure-` over HTTPS), 8 h. Claims `sub`, `oid`, `sv`. **Every** protected request re-loads the user (`resolveUser`): active, verified, same org, same `sessionVersion`. Roles/permissions always come from the DB. |
| Revocation | `User.sessionVersion` bumps on suspension, role/status change, password reset/change, invitation acceptance. |
| Passwords / tokens | Argon2id (19 MiB, t=2). One-time tokens stored as SHA-256, consumed atomically; TTLs invitation 72 h, verification 24 h, reset 30 min. |
| Rate limiting | MongoDB fixed-window counters (`ratelimits`, hashed keys, TTL), shared by all instances. Per-IP limits only with `TRUST_PROXY_HEADERS=true`. |
| CSRF | NextAuth endpoints: its own token. `/api/v1` mutations: `Origin` = `APP_URL` (or `Sec-Fetch-Site: same-origin`) **and** JSON body. |
| Multi-tenancy | Every business document has `organizationId` taken from the authenticated user; foreign ids → 404. |
| **Transactions (phase 2)** | Booking create/update/transition, address change and cleaner state changes run in MongoDB multi-document transactions (`lib/db/transaction.ts`: snapshot read, majority write, ≤5 attempts with jittered backoff on `TransientTransactionError`/WriteConflict, then 409 `BUSY_RETRY`). **Requires a replica set** — MongoDB Atlas is one; tests use Atlas or an in-memory single-node replica set. |
| **Scheduling concurrency** | See "Scheduling concurrency mechanism" below. |
| Rendering | Server Components by default; client components for forms, dialogs, autocomplete, calendar. `(auth)`/`(dashboard)` are `force-dynamic` and `requirePageUser` calls `connection()`. FullCalendar is lazy-loaded client-only (`next/dynamic` with `ssr:false`). |
| Headers | CSP (`script-src 'self' 'unsafe-inline'`; `font-src 'self' data:` for FullCalendar's embedded icon font), HSTS (prod), DENY framing, nosniff, Referrer-Policy, Permissions-Policy, COOP. Private routes: `X-Robots-Tag: noindex`, `Cache-Control: private, no-store`. |
| Money / time | Integer cents; UTC storage; rendering in the org timezone (default `America/Toronto`, `CAD`). Local↔UTC conversion is explicit about DST (`lib/domain/zoned-time.ts`). |
| Phone numbers | `libphonenumber-js` (MIT, `min` metadata, server-side only): stored as E.164 + digits (search) + display format + country; default country CA, `+` numbers keep their own country. |
| Calendar | **FullCalendar 6.1.21** (MIT; all packages pinned to the same version — v7 split its packages differently). Runs in `timeZone: "UTC"` with org wall-clock strings, so it always shows org-local time without a timezone plugin. |

## Layout

```
app/(public)          homepage
app/(auth)            login, forgot/reset password, verify email, accept invitation
app/(dashboard)       /dashboard/* pages (see "Screens")
app/api/v1/**         REST route handlers (thin; call modules/*)
components/ui         Button, Field/Input/Select, Alert, Badge, Card, EmptyState, Pagination, Modal(dialog)
components/ops        customer-form, address-fields/manager, booking-form, booking-list, booking-actions,
                      activity-feed, calendar-view/shell, column-picker, contact links, status badges, my-jobs
components/shell      nav, mobile drawer, access/coming-next
lib/domain            constants, normalize, money, time, zoned-time, phone, links (maps/tel), duration, allocations
lib/db                connect, transaction, models/*
modules/              audit, auth, users, organization, dashboard, customers (schemas/service/addresses),
                      catalog, cleaners, bookings (schemas/service), activities
scripts/              bootstrap-superadmin, sync-indexes, dev-services (--smtp-only), dev-fixtures
tests/                unit, auth, api-users, email-flows, operations (+ helpers)
```

Note: operational screens live under `/dashboard/...` (e.g. `/dashboard/customers/[id]`), consistent with phase 1.

## Screens and workflows (phase 2)

| Screen | What it does |
|---|---|
| `/dashboard` (office) | Today / tomorrow / unassigned upcoming / in progress counts (org timezone), completed-in-range (bookings, service items, unique customers — separate cards), today's jobs, upcoming jobs, quick actions. Every card links to the filtered bookings list. No financial KPIs. |
| `/dashboard` (cleaner) | "My jobs": own assigned jobs from today, mobile cards with customer phone, address + map, access notes, services, instructions, Start/Complete. |
| `/dashboard/customers` | Server pagination/sort/search (name, any-format phone, email), filters (current-address city, tag, active/archived), filter chips + reset, configurable columns (`?cols=`, remembered per browser). |
| `/dashboard/customers/new`, `[id]/edit` | Shared form; possible-duplicate review before create ("Create anyway"); optional primary address on create. |
| `/dashboard/customers/[id]` | Header (contact, call/email, edit, create booking, archive/restore, relationship duration, default address + map, tags). Tabs: Overview (metrics), Service addresses (add/edit/default/archive, links), Bookings & history, Notes & activity (notes + call outcomes), Payments (honest phase-3 state). |
| `/dashboard/services` | Catalog list/search/status, create/edit dialog, activate/deactivate. |
| `/dashboard/cleaners`, `[id]` | List/search/status; profile with upcoming + completed jobs, edit, deactivate/archive (lists affected future jobs), invite to sign in (existing invitation flow, role CLEANER) or link/unlink an existing CLEANER user. |
| `/dashboard/bookings` | Filters: date range, status, cleaner, booked city (snapshot), reference, unassigned; chips + reset; stable sort. |
| `/dashboard/bookings/new` | Debounced customer autocomplete (shows phone/email/city), inline customer creation, address picker + inline new address, date/time/duration (DST-aware), service items with previewed totals, cleaners, instructions vs office notes, scheduled or "record a past completed job". Prefill via `?customerId=&date=&time=` (from profile, calendar, dashboard). Idempotent submit; unsaved-change warning. |
| `/dashboard/bookings/[id]`, `[id]/edit` | Reference, status, customer (profile link only for office), contact actions, time + timezone, address snapshot + map + access notes, items and subtotal (if permitted), cleaners, instructions, office notes (office only), timeline, history; lifecycle actions; change address (future scheduled only). |
| `/dashboard/calendar` | Day / week / month / agenda; prev/next/today; cleaner, status and booked-city filters; visible-range fetching; status colours **and** text labels; click event → booking; click slot/day → prefilled new booking. Mobile defaults to agenda. |

## Models and indexes

Phase-1 models are unchanged except where noted. All indexes are declared next to each schema; apply with `npm run db:indexes`.

- **Customer** (changed): `name` (display), `searchName`, `firstName`, `lastName`, `companyName`, `customerType` (individual/business/referral_partner/other), `email` (optional), `phone` (E.164), `phoneDigits`, `phoneDisplay`, `phoneCountry`, `relationshipStartedAt` (date-only, stored 00:00 UTC), `contactSource`, `tags`, `notes`, `addressCities[]` + `primaryCity` (denormalised from active addresses), `archivedAt/By`, `createdBy`. **No uniqueness on phone/email.** Indexes: `{org, archivedAt, searchName, _id}`, `{org, archivedAt, createdAt, _id}`, `{org, email}`, `{org, phone}`, `{org, phoneDigits}`, `{org, tags}`, `{org, addressCities}`.
- **ServiceAddress** (changed): + `accessInstructions`, `links[{label,url}]` (http/https only), `archivedAt`; `isPrimary` = default (exactly one among active addresses, maintained by the service). Index `{org, customerId, archivedAt}`, `{org, cityNormalized}`.
- **Service** (changed): + `searchName`, `category`, `currency` (org currency at creation), `unitLabel`. Index `{org, active, searchName, _id}`.
- **Cleaner** (changed): `name`, `searchName`, `phone`/`phoneDisplay`, `email`, `active`, `serviceAreas`, `notes`, `linkedUserId` (unique when set — one user ↔ one cleaner), `scheduleRevision` (lock), `archivedAt/By`.
- **Booking** (changed): `reference` (unique per org), `idempotencyKey` (unique per org when set), `timezone`, `status` **SCHEDULED/IN_PROGRESS/COMPLETED/CANCELLED** (was lower-case; no data existed to migrate), `instructions` (cleaner-visible), `officeNotes`, `addressSnapshot` (+ `accessInstructions`), `lineItems[{_id (stable), serviceId, name, unitLabel, quantity, unitPriceCents, catalogUnitPriceCents, durationMinutes, lineTotalCents}]`, `currency`, `subtotalCents` (was `totalCents`), `actualStartedAt`, `completedAt`, `cancelledAt`, `cancellationReason`, `version`, `createdBy`. Indexes add `{org, reference}` unique, `{org, idempotencyKey}` unique-partial, `{org, assignedCleanerIds, status, scheduledStartAt, scheduledEndAt}` for overlap checks.
- **Activity** (new): `organizationId`, `customerId`, `bookingId`, `actorId`, `type`, `visibility` ("office"), `content`, `callOutcome`, `metadata` (redacted), `dedupeKey` (unique-partial → retried requests never duplicate events), `occurredAt`. Indexes `{org, customerId, occurredAt, _id}`, `{org, bookingId, occurredAt, _id}`.
- **Organization** (changed): + `scheduling.bufferMinutes` (default 0).
- Payment, CustomFieldDefinition, LoyaltyEntry: unchanged, ready for phase 3. `Payment.allocations[].lineItemId` targets the stable booking line-item ids.

## Permissions and field-level restrictions

| Role | Permissions |
|---|---|
| SUPERADMIN | everything |
| ADMIN | all operational incl. `pricing:read`, `bookings:price_override`, `bookings:reopen`, `activities:write`; users (STAFF/CLEANER only); organization (non-protected) |
| STAFF | base: `dashboard:view`, `account:self`, `customers:read`, `services:read`, `bookings:read`, `calendar:read`, `activities:write`; grantable: `customers:write`, `services:write`, `bookings:write`, `pricing:read`, `bookings:price_override`, `cleaners:read/write`, `payments:*`, `reports:read`, `loyalty:*` |
| CLEANER | `dashboard:view`, `account:self`, `bookings:read_assigned`, `bookings:transition_assigned` |

Field shaping happens on the server (`shapeBookings`, `toServiceDTO`, `customerHistory`), so forbidden data is never sent:
- Prices, line totals and subtotals: only with `pricing:read` (catalog editing also requires it).
- Office notes, cancellation reason, activity history, address ids: office users only — never cleaners.
- Cleaners: only bookings where their linked cleaner record is assigned (others → 404). They get customer name, phone, email, booking address + access notes, services, instructions. No customer profile (`/customers/*` → 403/AccessDenied), no lists, no payments/loyalty, no prices.
- Price overrides require `pricing:read` + `bookings:price_override` and are audited (`booking.price_overridden`).

## Booking statuses and transitions

| Action | From → To | Who |
|---|---|---|
| start | SCHEDULED → IN_PROGRESS (sets `actualStartedAt`) | `bookings:write`, or assigned cleaner (`bookings:transition_assigned`) |
| complete | SCHEDULED/IN_PROGRESS → COMPLETED (sets `completedAt`) | same as start |
| cancel | SCHEDULED/IN_PROGRESS → CANCELLED (reason required) | `bookings:write` |
| reopen | COMPLETED → IN_PROGRESS (reason required, audited, re-checks conflicts) | `bookings:reopen` |

CANCELLED is terminal. Editable fields by status: SCHEDULED — schedule, items, cleaners, instructions, office notes, address; IN_PROGRESS — cleaners, instructions, office notes; COMPLETED/CANCELLED — office notes only (completed line items are locked; correct them via audited *reopen*). Removing a line item that has payment allocations is blocked (409 `LINE_ITEM_HAS_PAYMENTS`). Cancellation never deletes or refunds payments. Every write bumps `version`; writers send `expectedVersion` → 409 `STALE_VERSION` on mismatch.

## Scheduling concurrency mechanism

Inside one transaction (`lockAndCheckCleaners`):
1. **Lock**: `findOneAndUpdate` each assigned cleaner (sorted ids) with `$inc: { scheduleRevision: 1 }`, filtered on org (+ `active: true, archivedAt: null` for newly assigned cleaners). Two transactions touching the same cleaner both write that document, so MongoDB aborts one with a write conflict; it retries (bounded) and then sees the winner's booking. A missing/inactive cleaner → 409 `CLEANER_UNAVAILABLE`.
2. **Overlap query**: same org, cleaner in set, status SCHEDULED/IN_PROGRESS, `scheduledStartAt < newEnd + buffer` AND `scheduledEndAt > newStart − buffer`, excluding the booking itself. Any hit → 409 `SCHEDULE_CONFLICT` with `{cleanerName, reference, bookingId, start, end}` per conflict. Adjacent jobs (end == start) are allowed when the buffer is 0; cancelled and completed jobs never block.
3. Insert/update the booking and its activity in the same transaction.

Deactivating/archiving a cleaner also increments `scheduleRevision` in a transaction, so it can't race an assignment. Existing assignments are kept and returned (`affectedBookings`) for explicit reassignment.

## Date, count and amount definitions

- **Times**: stored UTC; entered/displayed in the org timezone. Each booking stores the `timezone` used. Nonexistent local times (spring-forward gap) → 422 `NONEXISTENT_LOCAL_TIME`; ambiguous ones (fall-back overlap) → 422 `AMBIGUOUS_LOCAL_TIME` with both options, resolved by `disambiguation: "earlier"|"later"`. Day ranges handle 23/25-hour days.
- **Service date** = the booking's scheduled start date in the org timezone (not `actualStartedAt`/`completedAt`).
- **Completed bookings** = bookings with status COMPLETED.
- **Completed service items** = sum of line-item `quantity` in completed bookings.
- **Distinct service days** = distinct org-local calendar dates of the scheduled start of completed bookings (two jobs on one day = 1).
- **Upcoming bookings** = SCHEDULED with scheduled start ≥ now.
- **Today/Tomorrow** (dashboard) = non-cancelled bookings whose scheduled start falls on that org-local date. **Unassigned upcoming** = SCHEDULED, start ≥ now, no cleaners.
- **Relationship duration** = from `relationshipStartedAt` (never the record's creation date); "Not specified" if unknown.
- **Quantities** are whole numbers 1–1000; **unit prices** integer cents 0–$100,000; **durations** whole minutes (service 0–1440, booking 15–1440). Line total = quantity × unit price; **service subtotal** = sum of line totals — no taxes or discounts, and never treated as money received. Totals are always computed on the server.
- **Booking reference** `RP-YYMMDD-XXXXX`: random from a 31-character unambiguous alphabet, uniqueness-checked; never derived from counts.
- **Idempotency**: the booking form sends a random `idempotencyKey` per form session; replays (double clicks, retries after network errors) return the original booking (HTTP 200) and record no extra activity.

## Route contracts (`/api/v1`, JSON `{ data }` / `{ error: { code, message, details? } }`)

Phase 1 (unchanged): `auth/*`, `account/*`, `users*`, `organization`, `audit-events`, `dashboard/summary`, `health`.

| Method & path | Permission | Notes |
|---|---|---|
| GET `/customers` | customers:read | `page, pageSize≤100, q, city, tag, status(active\|archived\|all), sort(name\|createdAt\|relationshipStartedAt\|updatedAt), dir` |
| POST `/customers` | customers:write | 409 `POSSIBLE_DUPLICATES` (`details.matches`) unless `confirmDuplicate:true`; optional `primaryAddress` |
| GET `/customers/lookup?q=` | customers:read | ≤10 active matches with phone/email/city |
| POST `/customers/duplicate-check` | customers:read | body = customer fields |
| GET/PATCH `/customers/:id` | read / write | strict schema |
| POST `/customers/:id/archive` | customers:write | `{archived: boolean}` (soft) |
| GET/POST `/customers/:id/addresses` | read / write | `?archived=1` to include archived |
| PATCH/DELETE `/customers/:id/addresses/:addressId` | customers:write | DELETE = soft archive; bookings keep snapshots |
| GET `/customers/:id/history` | bookings:read | paginated service history (prices only with pricing:read) |
| GET `/customers/:id/summary` | bookings:read | metrics + `payments.available=false` until phase 3 |
| GET/POST `/services`, PATCH `/services/:id` | services:read / services:write + pricing:read | |
| GET/POST `/cleaners`, GET/PATCH `/cleaners/:id` | cleaners:read / write | |
| POST `/cleaners/:id/state` | cleaners:write | `{state: active\|inactive\|archived}` → `affectedBookings` |
| POST `/cleaners/:id/invite` | users:invite + cleaners:write | existing invitation flow, role CLEANER, then link |
| POST `/cleaners/:id/link-user` | cleaners:write + users:manage | `{userId \| null}`; 409 `USER_ALREADY_LINKED` |
| GET `/cleaners/linkable-users`, GET `/cleaners/:id/schedule` | cleaners:* | |
| GET `/bookings` | bookings:read (or own, for cleaners) | `page, pageSize, status, from, to, cleanerId, customerId, city, unassigned=1, q(reference prefix), dir` |
| POST `/bookings` | bookings:write | `{idempotencyKey, customerId, addressId, date, startTime, durationMinutes, disambiguation?, lineItems[{serviceId, quantity, unitPriceCents?}], cleanerIds[], instructions, officeNotes, status: SCHEDULED\|COMPLETED}` → 201 (new) / 200 (replay); 409 `SCHEDULE_CONFLICT`/`CLEANER_UNAVAILABLE`/`BUSY_RETRY`; 422 DST codes |
| GET `/bookings/options` | bookings:write | active services + assignable cleaners |
| GET/PATCH `/bookings/:id` | read (shaped) / write | PATCH requires `expectedVersion`; line items keep ids via `lineItemId` |
| POST `/bookings/:id/transition` | see table | `{action, expectedVersion, reason}`; 409 `INVALID_TRANSITION`/`STALE_VERSION` |
| POST `/bookings/:id/address` | bookings:write | future SCHEDULED only; audited + activity |
| GET `/bookings/my-jobs` | bookings:read_assigned | cleaner workspace |
| GET `/calendar/events` | calendar:read (or own) | `start,end` local dates inclusive, ≤62 days; `cleanerId,status,city` |
| GET/POST `/activities` | office read / activities:write | `customerId` or `bookingId`; POST `{kind: note\|call, content, callOutcome?}` |
| GET `/dashboard/operations` | bookings:read | `from,to` local dates (≤1 year) |

All lists use allowlisted filters/sorts with an `_id` tie-breaker, escaped bounded search, server pagination and org scoping. Browsers never send MongoDB query objects (strict zod schemas reject unknown keys and operators).

## Commands

`npm run dev` · `npm run dev:services` (`-- --smtp-only` to use your own DB) · `npm run dev:fixtures -- --org-id <id> --yes` · `npm run typecheck` · `npm run lint` · `npm test` (optionally `TEST_MONGODB_URI=…`) · `npm run build` · `npm run check` · `npm run db:indexes` · `npm run bootstrap:superadmin -- --name … --email …`

## Checks

**Phase 2 (2026-10-15)** — final full run: **71/71 tests passed** (5 files, 770 s against a remote throwaway database); summary:
- `npm run typecheck` ✔, `npm run lint` ✔ (0 problems), `npm run build` ✔ (all new routes dynamic).
- `npm test` with `TEST_MONGODB_URI` (throwaway `realtypacer_test_*` DB on Atlas; dropped afterwards) — new `tests/operations.test.ts` (23 tests): customer without email / no login account, name+contact rules, duplicate warning + knowing continue, search by name/partial phone/email, regex-injection-safe lookup, current-city filter, cross-org 404s, single default address + encoded map URLs, unsafe links rejected, multi-item server totals and reference format, idempotent creation (3 parallel replays → 1 booking, 1 activity), client totals/unknown fields rejected, price-override permission, inactive service rejected, pricing hidden without permission, historical price + address preserved after catalog/address edits, explicit address refresh recorded, overlap blocked with conflict details, adjacent allowed, cancelled doesn't block, **4 simultaneous conflicting requests → exactly 1 succeeds**, reassignment + stale version + inactive cleaner, transition table incl. locked completed items and reopen permission, cancel keeps history, DST gap/overlap (2030 dates), completed bookings / items / distinct service days (incl. 23:00 local), today/tomorrow/unassigned in org time, calendar range limit, cleaner sees only assigned jobs without prices/office notes/profile/activities and can start but not cancel, one user ↔ one cleaner, manual call outcomes.
- Manual browser pass (dev server, throwaway `realtypacer_e2e_*` DB, local SMTP sink): bootstrap → sign in → create service → create cleaner → create customer (no email, address, tags, since-date) → create booking from profile (address auto-selected, duration suggested 3 h, subtotal preview $240) → booking detail → calendar week view (org time, filters, legend) → open booking from calendar → start + complete by keyboard → customer metrics (1 booking, 2 items, 1 day) and history. Mobile 375 px: dashboard, profile, booking form, autocomplete by partial phone, calendar agenda default — no horizontal overflow. Fixes made from this pass: CSP blocked FullCalendar's icon font; calendar didn't scroll to 7 a.m.; am/pm missing in event times; **dialogs focused the close button so Enter cancelled instead of confirming** (now `data-autofocus` on the primary control).

**Phase 1**: typecheck/lint/build ✔, 48/48 tests, browser pass (auth flows, user admin, mobile drawer focus handling). Details in git history of this file / README.

Not verified: real SMTP delivery (only a local SMTP sink); the in-memory MongoDB test path (its ~800 MB binary couldn't be downloaded on this connection — tests ran against throwaway Atlas databases instead); screen-reader testing with an actual assistive technology; a cleaner signing in through the browser (covered by service tests, not clicked through); performance with large datasets.

## Known limitations / follow-ups

- Sign-in redirects from deep dashboard links return to `/dashboard` (layout guard runs first).
- Drag-and-drop rescheduling is intentionally not enabled; rescheduling uses the edit form (keyboard accessible, server-validated).
- Customer name search uses an unanchored regex on `searchName` (fine for small/medium orgs); add a text/Atlas Search index if customer counts grow large.
- Per-email login limit can temporarily lock out a known address (standard trade-off).
- CSP keeps `'unsafe-inline'` for scripts; nonce upgrade path via `proxy.ts`.
- Business contact details from the reference screenshot were not used anywhere; enter them in Organization settings if wanted.

## Integration points for phase 3

- **Payments**: allocate to `Booking.lineItems[]._id` (stable; ids preserved on edit; removal blocked once allocated). Use `findLineItemOverAllocations` + a transaction; count only `COUNTING_PAYMENT_STATUSES`. Fill the customer "Payments" tab and `/customers/:id/summary.payments` (total paid, outstanding = completed subtotals − allocated, clearly defined).
- **Combined filters / reports**: booking city = `addressSnapshot.cityNormalized`; service = `lineItems.serviceId`; service date = scheduled start in org tz (`$dateToString` with timezone, as in `customerMetrics`). Customer city = `addressCities`. Keep allowlisted filters.
- **Custom fields**: `customFields` exists on Customer, ServiceAddress and Booking; add validation against `CustomFieldDefinition` and column/filter support in the customer list column picker.
- **Loyalty**: `LoyaltyEntry` ledger keyed by customer, reference `booking`/`payment`.
- Reuse: `route()`, `requireApiUser`, `requirePageUser`, `withTransaction`, `recordActivity`, `recordAudit`, `shapeBookings` for permission-aware DTOs.
