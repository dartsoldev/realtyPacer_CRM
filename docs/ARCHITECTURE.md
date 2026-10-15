# Architecture

## Overview

- **Next.js 16 App Router (Node runtime)**: Server Components render pages; client components only for forms, dialogs, the calendar, the report builder, calling and uploads.
- **REST API** under `/api/v1/*`: thin route handlers (`route()` wrapper) → service modules in `modules/*` → Mongoose models in `lib/db/models/*`.
- **MongoDB replica set**: every business document carries `organizationId` taken from the session user; foreign ids → 404. Multi-document transactions (`lib/db/transaction.ts`) protect bookings, payments, credit, refunds and points.
- **Auth**: NextAuth v4 credentials provider, JWT session cookie (HttpOnly, SameSite=Lax, 8 h). Each request re-loads the user (active, verified, same org, same `sessionVersion`), so suspension, role change and password reset take effect immediately.
- **Background worker** (`scripts/worker.ts` → `dist/worker.cjs`): email outbox delivery and upload clean-up. No timers in web requests.
- **proxy.ts**: per-request nonce CSP, `x-request-id`, Permissions-Policy (microphone only when browser calling is on).

## Request flow

```
browser ──HTTP──▶ proxy.ts (request id, CSP nonce)
                 ├─ page (Server Component) ─ requirePageUser ─ modules/* ─ MongoDB
                 └─ /api/v1/* ─ route(): same-origin + JSON check for mutations
                                └─ requireApiUser(permission) ─ zod schema ─ modules/* ─ MongoDB / S3 / SMTP outbox / Twilio
```

API contract: JSON `{ data }` on success, `{ error: { code, message, details? } }` on failure (400 validation with field errors, 401, 403, 404, 409 conflicts such as `STALE_VERSION`/`SCHEDULE_CONFLICT`, 422 business rules, 429 rate limit with `Retry-After`, 503 `SETUP_REQUIRED`/`*_NOT_CONFIGURED`, 500 with `requestId`). Strict zod schemas reject unknown keys; filters/sorts are allowlisted; browsers never send MongoDB query objects.

## Modules

| Module | Responsibility |
|---|---|
| `auth`, `users`, `organization`, `audit` | Account lifecycle, invitations, roles/grants, settings, audit trail |
| `customers` (+ `addresses`) | Profiles, duplicates, search, addresses/map links, history, metrics |
| `catalog`, `cleaners` | Services, cleaner profiles, sign-in linking |
| `bookings` (+ `emails`) | Booking lifecycle, assignment conflicts, calendar, customer booking emails |
| `activities`, `calls` | Timeline notes; call logs (phone app and Twilio browser calls) |
| `finance` | Charges (draft/finalized, discount, tax snapshot, adjustments), receipts/allocations/credit/refunds/reversals, summaries, dashboard cards |
| `reports` | Allowlisted filter registry, report engine (3 modes), CSV export, saved views |
| `custom-fields`, `loyalty` | Field definitions/validation; points ledger |
| `notifications`, `outbox` | In-app notices; persistent email queue |
| `imports` | Customer CSV import (map → preview → decide → batched run) |
| `attachments` | Private photos/documents in S3-compatible storage |
| `system` | Diagnostics for administrators |

## Integrations

| Integration | Mode | Trust boundary |
|---|---|---|
| SMTP | Auth emails sent directly (with immediate feedback); booking/security notifications via the outbox | Templates escape all values; links use `APP_URL`; subjects stripped of CR/LF |
| S3-compatible storage | Presigned PUT (5 min, random key) → server verification (size, magic bytes, image decode, thumbnail) → authenticated streaming reads | Bucket private; keys never accepted from clients; reads re-authorized per request |
| Twilio Voice (optional) | Server issues 10-minute outgoing-only tokens; browser sends only a call-log id; TwiML dials the stored number with the configured caller ID | `X-Twilio-Signature` validated against `APP_URL`; callbacks idempotent by `SequenceNumber`; per-user/org rate limits |

## Financial and reporting definitions

See `PROJECT_STATE.md` → “Phase 3” for exact definitions (gross, discount, net, tax, charged, allocated, outstanding, credit, net received), invariants, report modes and date semantics. Money is integer cents in one currency per organization.

## Security headers

`proxy.ts` (pages): `Content-Security-Policy` with per-request nonce + `'strict-dynamic'` (no inline scripts), `connect-src` widened only for configured storage/Twilio, `frame-ancestors 'none'`. `next.config.ts` (all): `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, HSTS (production). Private routes: `X-Robots-Tag: noindex` and `Cache-Control: private, no-store`. File downloads: `nosniff`, `Content-Disposition: attachment` for documents, sandbox CSP, `Cross-Origin-Resource-Policy: same-origin`.
