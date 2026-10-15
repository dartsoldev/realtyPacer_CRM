# RealtyPacer

Configurable CRM for service businesses (initial workflow: cleaning services) — realtypacer.com.

**Phases 1–2 of 4 are implemented:** foundation, authentication, permissions and user administration (phase 1), plus the operational CRM — customers, service addresses, service catalog, cleaners, bookings, calendar, activity history and role-specific dashboards (phase 2). Payments, reporting, custom fields and loyalty (phase 3) show honest "coming next" states. See [PROJECT_STATE.md](PROJECT_STATE.md) for architecture, contracts and definitions.

## Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 16.4.1 (App Router, Turbopack), React 19.3, TypeScript (strict) |
| Auth | **next-auth 4.24.15** (latest stable; v5 is still `5.0.0-beta.x`, so it is intentionally not used) — Credentials provider, JWT session cookie |
| Database | MongoDB via Mongoose 9 |
| Passwords | Argon2id (`@node-rs/argon2`, 19 MiB / t=2 / p=1) |
| Email | Nodemailer 7 over SMTP |
| Validation | Zod 4 (server), React Hook Form (client) |
| UI | Tailwind CSS 4, Lucide icons, self-hosted Inter via `next/font/local` |
| Phone numbers | libphonenumber-js (default country Canada) |
| Calendar | FullCalendar 6.1.21 (MIT), lazy-loaded |
| Tests | Vitest 5, mongodb-memory-server (replica set) or a throwaway database, local `smtp-server` |

Node.js ≥ 20.9 is required (developed on Node 22).

## Setup

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill in `.env.local` (see below), then:

```bash
npm run db:indexes
```

```bash
npm run bootstrap:superadmin -- --name "Your Name" --email you@yourcompany.com --org-name "Your Business"
```

```bash
npm run dev
```

Open http://localhost:3000 and use the one-time setup link printed by the bootstrap command.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | yes | `mongodb+srv://USER:PASSWORD@HOST/realtypacer`. **URI-encode special characters** in the username/password (`@`→`%40`, `:`→`%3A`, `/`→`%2F`, `#`→`%23`, `%`→`%25`). |
| `APP_URL` | yes | Trusted public origin. Every emailed link is built from this, never from the request Host. Also used for the CSRF Origin check. |
| `NEXTAUTH_URL` | yes in prod | Must equal `APP_URL`. |
| `NEXTAUTH_SECRET` | yes | ≥ 32 random chars: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Rotating it signs everyone out. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | for email | Required for invitations, verification and password reset. Without them those features show a setup error and nothing is pretended to be sent. |
| `SUPERADMIN_EMAIL` | optional | Default email for the bootstrap CLI only. Grants nothing by itself. |
| `TRUST_PROXY_HEADERS` | optional | `true` only behind a proxy that overwrites `X-Forwarded-For` (e.g. Vercel). Enables per-IP rate limits; per-account limits always apply. |

Missing or invalid configuration is reported by name (never value) on the login/dashboard pages in development, and in server logs in production. `GET /api/v1/health` reports booleans for config, database and email.

### MongoDB / indexes

- Atlas (or any MongoDB ≥ 6). Allow your server's IP in the Atlas network access list.
- **A replica set is required** (Atlas clusters are replica sets): bookings use multi-document transactions to prevent double-booking cleaners. A standalone `mongod` will fail when saving bookings.
- If the URI has no database name (`…mongodb.net/`), the app uses the `realtypacer` database.
- `npm run db:indexes` creates every index declared in the schemas, including TTL indexes for expired auth tokens and rate-limit counters. Run it once per environment and after schema changes. (Development also auto-creates indexes; production does not.)
- Rate-limit counters live in MongoDB (`ratelimits` collection), so limits are shared across all server instances — no extra Redis service is required.

### SMTP and sender verification

- Use a transactional provider (Postmark, SES, Mailgun, SendGrid, Microsoft 365, etc.).
- The `EMAIL_FROM` domain must be verified with that provider (SPF + DKIM, ideally DMARC) or messages will be rejected or land in spam.
- Port 587 with `SMTP_SECURE=false` uses STARTTLS (TLS is required for non-localhost hosts); port 465 uses `SMTP_SECURE=true`.
- "Sent" in the UI means the SMTP server **accepted** the message. It is not proof of inbox delivery. Failures are shown to admins with a retry action and written to the audit log.
- Do not use the business contact address from the reference screenshot as a sender or test recipient.

### First superadmin

There is no public sign-up and no default password. The first superadmin is created on the server:

```bash
npm run bootstrap:superadmin -- --name "Jane Owner" --email owner@example.com
```

- Default `--mode invite`: prints a single-use setup link (72 h) to the terminal. Add `--send-email` to also email it.
- `--mode password`: prompts twice for a password with hidden input; the email is recorded as operator-attested.
- Refuses to run if any superadmin already exists and never elevates an existing account.
- If the organization ever loses every superadmin (e.g. a crash during a compensated demotion), the same command can be used to recover.

## Troubleshooting

- **Login page says "Setup required" / "see README"** — a required variable is missing or invalid. Most often `NEXTAUTH_SECRET` is too short: it must be at least 32 random characters. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`, then restart `npm run dev`. In development the page lists which variable is wrong (names only, never values).
- **PowerShell drops the `--`** in `npm run bootstrap:superadmin -- --name … --email …`, so npm consumes the flags itself. The script recovers them, so that command works as written. These forms also work in any shell:

  ```bash
  npx tsx --conditions=react-server scripts/bootstrap-superadmin.ts --name "Your Name" --email you@example.com
  ```

- **Gmail SMTP**: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER` = the Gmail address, `SMTP_PASSWORD` = a 16-character Google *App Password* (requires 2-Step Verification), `EMAIL_FROM` = `RealtyPacer <same Gmail address>`.

## Local development without external services

```bash
npm run dev:services
```

Starts an in-memory MongoDB on `127.0.0.1:27027` (add `-- --smtp-only` to start just the mail sink and use your own database) and an SMTP sink on `127.0.0.1:2525` that saves emails to `.dev-mail/` (gitignored). Point `.env.local` at them:

```
MONGODB_URI=mongodb://127.0.0.1:27027/realtypacer
SMTP_HOST=127.0.0.1
SMTP_PORT=2525
SMTP_SECURE=false
EMAIL_FROM=RealtyPacer Dev <dev@localhost>
```

Data is discarded when the process stops.

Optional synthetic sample data (sofa/carpet/mattress/house cleaning services, two cleaners, two fictional customers) for a **development** organization only:

```bash
npm run dev:fixtures -- --org-id <organization id> --yes
```

It refuses in production, without `--yes`, or if the organization already has services.

## Checks

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm test
```

```bash
npm run build
```

`npm run check` runs all four. Tests use a local SMTP server (no email leaves the machine) and, by default, an in-memory MongoDB whose ~800 MB binary is downloaded into `node_modules/.cache` on first run. On a slow connection, point them at any MongoDB instead — each run creates a randomly named `realtypacer_test_*` database there and drops it afterwards; the database name in the URI is always replaced:

```bash
TEST_MONGODB_URI="mongodb+srv://USER:PASSWORD@HOST/" npm test
```

## What works now

- Everything from phase 1: sign-in and account flows, invitations, roles and staff grants, user administration, organization settings, audit history.
- **Customers**: searchable/sortable/filterable list with configurable columns, create/edit with duplicate warnings, profiles with metrics, multiple service addresses (map links, access notes, safe external links), service history, notes and call outcomes, soft archive.
- **Services**: catalog with prices (integer cents), units, durations, activation.
- **Cleaners**: profiles, availability (deactivation lists affected jobs), explicit sign-in invitation or account linking, schedules.
- **Bookings**: idempotent creation with customer autocomplete and inline customer/address creation, multiple service items with server-side totals, cleaner assignment with double-booking prevention (transactional), DST-aware times, lifecycle (start/complete/cancel/reopen), optimistic-concurrency edits, address snapshots.
- **Calendar**: day/week/month/agenda in the organization timezone, filters, click to open or create.
- **Dashboards**: office operations overview with money cards (each states its date basis); "My jobs" for cleaners with only the information they need.
- **Billing**: draft estimates → finalized charges with an optional discount and an optional single sales-tax rate (off until configured, snapshotted per booking); append-only adjustments and cancellation credits.
- **Payments** (manual receipts for money received outside RealtyPacer): partial, multiple and multi-booking payments allocated to specific booked services, customer credit and later application, recorded refunds, reversal of mistaken receipts, printable acknowledgment. Concurrency-safe and idempotent.
- **Customer finance and loyalty**: lifetime summary from authoritative records, open charges, payment history; points ledger with reasons and reversals.
- **Reports**: Service performance, Customer summary and Cash received with combined AND filters (e.g. city is any of Mississauga, Toronto AND service is Sofa cleaning), date presets, sortable paginated results, column choice, breakdowns with optional charts, saved private/shared views and server-side CSV export.
- **Custom fields** for customers, bookings and cleaners (8 types), with safe generated keys, archive/restore and cleaner visibility for booking fields.

RealtyPacer does **not** process online or card payments, send refunds, or place calls from the browser. Payments are records of money received elsewhere; never enter card numbers.

## Walkthrough

1. **Create a customer** — Customers → *Add customer*. Choose the type, enter a name and a phone (Canada by default; start with `+` for other countries) or an email, optionally the "customer since" date, tags and the primary service address. If similar customers exist you'll see them first and can choose *Create anyway*.
2. **Add an address** — open the customer → *Service addresses* → *Add address*. Tick "Default address for new bookings" if it should be preselected. Access/parking notes are shown to office staff and assigned cleaners.
3. **Create a service** — Services → *New service*: name, unit price, unit (e.g. sofa, room, hour) and estimated minutes per unit.
4. **Create a cleaner** — Cleaners → *New cleaner*. This never grants sign-in; use *Invite to sign in* on their profile (needs an email) when they should see their jobs.
5. **Schedule and assign a booking** — from the customer profile (*Create booking*), the Bookings page, the dashboard or by clicking a time in the calendar. Pick the address, date and start time, add services and quantities (the duration is suggested from the services), tick cleaners, add instructions (cleaner-visible) and office notes (internal), then *Create booking*. Overlapping jobs for the same cleaner are refused with the conflicting job shown.
6. **Open it in the calendar** — on the booking page choose *In calendar*, or open Calendar; click the job to return to it.
7. **Complete it and review history** — on the booking page use *Start job* and *Complete job* (cleaners can do this from "My jobs"). The customer profile then shows the completed booking, service items, distinct service days and the booking in *Bookings & service history*.

## Demonstration path (phase 3)

1. **Organization → Sales tax** (superadmin, optional): enable e.g. "HST" at 13 %. Leave it off to finalize without tax.
2. **Custom fields → New field**: add "Number of pets" (number, list column, filterable) for customers and "Pet in house" (yes/no, visible to assigned cleaners) for bookings. Fill them in on a customer and a booking.
3. **Bookings**: create two completed bookings for a Mississauga customer (e.g. 1 sofa + 2 rooms carpet, and 1 sofa). On the first, open **Billing → Discount** (10 %), then **Finalize charges** on both. Drafts show "Draft estimate — nothing is owed".
4. **Record payment** from the booking's Billing card: enter more than the first booking's balance. The preview applies this booking first, then the oldest service dates; any rest is kept as credit.
5. **Payments → open the receipt**: see where it was applied, then **Record refund** for part of one service (after returning the money outside the app). The refunded service becomes owed again.
6. **Customer → Finance**: outstanding = finalized charges ± adjustments − net applied; net received = receipts − refunds. **Loyalty points** tab: grant points, redeem some, reverse an entry.
7. **Booking → Adjust charge**: add a goodwill credit to lower what's owed (no money moves). For a scheduled booking whose charges were finalized (e.g. a deposit) and then cancelled, use **Credit unpaid balance** so nothing stays owed.
8. **Reports**: *Service performance*, this month, add *Service city is any of Mississauga* and *Service is any of Sofa cleaning*. Check totals, sort, choose columns, turn on charts, **Save** the view (shared, "This month" moves with the calendar), and **Export CSV**. Switch to *Cash received* to see the refund in the month it was made.
9. **Dashboard**: the money cards (net cash this month, outstanding now, unapplied credit, completed work charged) link to the matching report or list. Sign in as a cleaner: no money, reports or office-only fields are visible.

## Not yet (phase 4)

Online payment processing, automatic refunds and browser calling are intentionally not implemented. Phase 4: integrations, performance work, a security review and deployment.
