# Release checklist (v1.0 candidate)

Legend — **Implemented**: code exists and is wired into screens/APIs. **Verified**: how it was checked in this repository (`U` unit/integration tests, `E` end-to-end over HTTP against the production build, `B` manual browser pass). **Dependency**: what must exist outside the code before it works in production.

| Requirement | Screen / API | Implemented | Verified | Remaining dependency |
|---|---|---|---|---|
| Customer profiles, relationship duration | `/dashboard/customers/[id]`, `GET/PATCH /api/v1/customers/:id` | Yes | U, E, B | — |
| Multiple service addresses, map links | Customer → Service addresses; `/api/v1/customers/:id/addresses` | Yes | U, E, B | — |
| Optional website/listing links | Address “links” (http/https only, up to 5) | Yes | U, E | — |
| Service history, service dates, accurate counts | Customer → Bookings & history, Overview metrics | Yes | U, E | — |
| Service catalog | `/dashboard/services`, `/api/v1/services` | Yes | U, E, B | — |
| Cleaner profiles, optional cleaner login | `/dashboard/cleaners/[id]`, `POST /api/v1/cleaners/:id/invite` | Yes | U, E | SMTP for invitations |
| Customer autocomplete, inline creation during booking | Booking form, `/api/v1/customers/lookup` | Yes | U, B | — |
| Booking create, reschedule, assignment, status transitions | `/dashboard/bookings/*`, `/api/v1/bookings*` | Yes | U, E, B | — |
| Calendar and agenda views | `/dashboard/calendar`, `/api/v1/calendar/events` | Yes | U, E, B | — |
| Assignment conflict prevention | Transactional cleaner locks | Yes | U (4 concurrent requests), E | MongoDB replica set |
| Client and cleaner calling actions | Call / copy / Log call on customer list+profile, booking, cleaner list+profile, cleaner job cards | Yes | U, B (Log call saved in production build) | — |
| Call activity logging | `POST/GET /api/v1/calls`, `PATCH /api/v1/calls/:id` | Yes | U | — |
| Browser calling (Twilio) | “Call in browser”, `/api/v1/calls/browser`, `/api/v1/telephony/twilio/*` | Yes (optional) | U (mocked network, real signature validation) | Twilio account, number, API key, TwiML app — **no live call placed** |
| Payments, allocations, refunds, credits, balances | `/dashboard/payments*`, Billing card, Finance tab, `/api/v1/payments*` | Yes | U, E, B | — |
| Combined city/service/date filters, accurate filtered totals | `/dashboard/reports`, `POST /api/v1/reports/run` | Yes | U, E, B | — |
| Custom fields, saved views | `/dashboard/custom-fields`, report views, `/api/v1/custom-fields`, `/api/v1/views` | Yes | U, E, B | `npm run db:indexes` for indexed fields |
| Points ledger | Customer → Loyalty points, `/api/v1/customers/:id/loyalty` | Yes | U, E | — |
| CSV export | Reports → Export CSV, `POST /api/v1/reports/export` | Yes | U, E | — |
| Multi-user dashboards and permissions | `/dashboard` (office vs cleaner), permission matrix | Yes | U, E | — |
| Superadmin user administration | `/dashboard/users`, `/api/v1/users*` | Yes | U, B | SMTP |
| Email verification, password reset, account lifecycle | `/verify-email`, `/forgot-password`, `/reset-password`, `/accept-invitation` | Yes | U, E | SMTP provider with verified sender — **real delivery not verified** |
| In-app notifications | Bell → `/dashboard/notifications`, `/api/v1/notifications` | Yes | U, E | — |
| Booking confirmation/change emails (outbox) | Booking → Email customer; Organization → Customer booking emails | Yes (off by default) | U, E (local SMTP sink + worker) | SMTP + running worker |
| Customer CSV import | `/dashboard/customers/import`, `/api/v1/imports*` | Yes | U, production-build API run with the sample file | — |
| Photos and attachments | Address “Photos and documents”, Booking “Photos and documents”, `/api/v1/attachments*` | Yes | U (in-memory storage), E (honest “not configured”) | S3-compatible bucket + CORS — **real storage not verified** |
| Responsive design / installable web app | All screens; `manifest.webmanifest`, `sw.js` (static assets only) | Yes | B (375 px for phase-3 screens; desktop for phase-4 screens); manifest/SW served (E) — **SW install not verified** (embedded browser refuses SW) | — |
| Public homepage, SEO, robots, sitemap | `/`, `/robots.txt`, `/sitemap.xml`, OG image | Yes | E | DNS for realtypacer.com |
| Security headers / CSP | `proxy.ts`, `next.config.ts` | Yes | E | — |
| Logging, health, readiness, diagnostics | `/api/v1/health`, `/api/v1/ready`, `/dashboard/system` | Yes | E, B | Log shipping/alerting (platform) |
| Performance on realistic data | `scripts/perf-dataset.ts` (5k customers / 40k bookings) | Yes (3 hot spots fixed) | Measured — see PROJECT_STATE “Checks” | Re-measure on production hardware |
| Deployment configuration | `Dockerfile`, `docker-compose.yml`, `docs/DEPLOYMENT.md` | Yes | Build + standalone server run (E); **Docker image not built here (no Docker on this machine)** | Hosting, DNS/TLS, secrets |
| Backups and restore | `docs/OPERATIONS.md` | Documented | **Not tested** (no backup-enabled cluster) | Atlas Cloud Backup (M10+) / bucket versioning |


### October 2026 refinement

| Requirement | Screen / API | Implemented | Verified | Remaining dependency |
|---|---|---|---|---|
| Customer profile as the central screen (Call, editable address + map, bookings vs services, paid per service, upcoming, notes, custom fields, points) | `/dashboard/customers/[id]`, `GET /api/v1/customers/:id/services`, `PATCH /api/v1/customers/:id/custom-fields` | Yes | U (paid per line, address edit keeps job snapshots, money hidden without access), E (page renders) | — |
| Excel-style customer & service filter with full-result totals | `/dashboard/customer-filter`, dashboard shortcut, `POST /api/v1/reports/customer-services` | Yes | U (Mississauga AND Sofa: 2 customers, $180 paid, carpet/Toronto/unpaid excluded; paging keeps totals; any-of; date; name; custom field column+filter), E | — |
| Owner-managed custom fields (Text, Number, Date, Dropdown, Checkbox) | `/dashboard/custom-fields` | Yes | U (rename keeps data; points/money labels refused) | — |
| Booking: customer + cleaner autocomplete, visible Unassigned | Booking form (`CleanerPicker`) | Yes | U (lookup, assignable cleaners, unassigned list) | — |
| Connected calendar, back-to-calendar, tomorrow at a glance | `/dashboard/calendar?date=&view=`, booking `?from=calendar`, dashboard Today/Tomorrow | Yes | U (tomorrow's jobs carry customer, service, city, cleaner, status), E | — |
| Cleaner requires name + phone, email optional, no automatic login | `/dashboard/cleaners` | Yes | U | — |
| Google Calendar (outbound) | Administration → Integrations, `/api/v1/integrations/google/*`, worker | Yes | U with mocked Google API (create, update, cancel, 409, backoff, manual retry, invalid_grant, encryption, single-use state, busy times); E ("Not connected") | Google Cloud OAuth client + 3 env vars — **no real Google account connected** (docs/GOOGLE_CALENDAR.md) |
| Leads (General/service and Real estate), manual + CSV, Convert to customer | `/dashboard/leads`, `/api/v1/leads*` | Yes | U (conversion retry/concurrency creates one customer, history kept), E | — |
| Website form intake | `POST /api/v1/intake/leads/:sourceId`, Integrations → Website lead forms | Yes | U (both categories, mapping, retries, bad key, paused, 422, 415, rate limit, logs without secrets), E (real HTTP, no cookies) | Client's form platform details — **no live website lead received** (docs/LEAD_SOURCES.md) |
| Focused dashboard and navigation | `/dashboard`, main nav / More / Administration | Yes | E (renders) | — |
| Permissions and organization isolation for the above | permission matrix | Yes | U, E (cleaner refused leads, sources, integrations, filter) | — |

## Go-live gates (outside the code)

1. MongoDB replica set with backups enabled; app user restricted to the database.
2. SMTP provider with SPF/DKIM/DMARC for the sender domain; send a test reset email.
3. Container host + TLS proxy for realtypacer.com; secrets set; `migrate` run; superadmin bootstrapped.
4. Worker running (System status shows a fresh heartbeat).
5. Optional: private S3 bucket + CORS; Twilio configuration; a controlled test call to an internal number.
6. A restore test from a real snapshot.
