# Operations: logging, monitoring, backup and recovery

## Logging

- Every request gets an `x-request-id` (generated in `proxy.ts`, or kept from an incoming header matching `[A-Za-z0-9-]{8,64}`), returned in the response and attached to API error logs. A 500 response shows only that id to the user.
- Logs are one JSON object per line on stdout/stderr: `level`, `event`, `time`, plus context such as `requestId`, `method`, `path` (ids replaced by `:id`), `code`, `organizationId`/entity ids where relevant.
- Redaction (`lib/security/redact.ts`) runs on every payload: keys that look like passwords, tokens, secrets, cookies, signatures or SMTP settings are removed; MongoDB/URL credentials are stripped; emails and phone numbers are masked; 13–19-digit runs (card-like numbers) are dropped. Stack traces are truncated to 6 frames and stay server-side.
- Ship stdout to your platform's log store; alert on `level=error` and on these events: `api.unhandled_error`, `config.incomplete`, `startup.config_invalid`, `outbox.delivery_failed` (`final: true`), `worker.batch_error`, `telephony.bad_signature` (bursts), `auth.*` failures.

## Monitoring

| Signal | Where | Notes |
|---|---|---|
| Liveness | `GET /api/v1/health` → `{"status":"ok"}` | No configuration or topology details. Container `HEALTHCHECK` uses it. |
| Readiness | `GET /api/v1/ready` → 200 `ready` / 503 `not_ready` | Valid required config and a database ping (3 s timeout). Use for load-balancer routing. |
| Diagnostics | Admin → **System status** (`GET /api/v1/system/status`, `system:diagnostics` only) | Database latency, email/storage/calling configured (variable names only for problems), worker heartbeat age, outbox counts, failed emails with **Retry**. |
| Worker | heartbeat in `workerheartbeats` (`_id: "outbox"`) | “Stale” after 120 s without a beat → check the worker container. |

## Background work

- `node dist/worker.cjs` polls the email outbox every `WORKER_POLL_SECONDS` (default 15): up to 50 due messages per batch, atomically claimed with a 2-minute lease, retried after 1 min, 5 min, 15 min, 1 h, 3 h, then marked **failed** (rejected recipients fail immediately). Hourly it deletes uploads that were never completed (24 h).
- Failed messages stay visible on System status with the error category (e.g. `SMTP_AUTH`, `SMTP_CONNECTION`) and can be retried. Nothing is sent twice: every message has a unique `dedupeKey`.
- No in-memory timers run inside web requests.

## Backups (you must set these up — this document does not create them)

**MongoDB** (all business data: customers, bookings, payments, ledgers, audit):
- Atlas: use a tier with **Cloud Backup** (M10+), enable continuous backup / point-in-time restore, keep at least 7 days of PITR and 30 days of daily snapshots, and restrict who can restore. Shared/free tiers do **not** provide restorable backups suitable for production.
- Self-hosted replica set: scheduled `mongodump --oplog` (or filesystem snapshots of a hidden secondary) to encrypted, off-host storage; retain 30 days.
- Collections that may be excluded from restores: `ratelimits` (TTL counters), `notifications` (180-day TTL), `importjobs` (14-day TTL).

**Object storage** (photos/documents):
- Enable bucket **versioning** and a lifecycle rule that expires non-current versions after 30–90 days; enable provider replication to a second region/account if you need disaster recovery.
- MongoDB holds only metadata and random keys. A database restore to time *T* references objects that existed at *T*; versioning lets you recover objects deleted after *T*.

## Restore procedure

1. Stop writes: scale `web` and `worker` to 0 (or put the proxy in maintenance mode).
2. Restore MongoDB to a **new** cluster/database at the chosen time (Atlas: Restore → point in time → new cluster). Never restore over the live database first.
3. Verify on the restored copy: run `node dist/sync-indexes.cjs`, sign in as an admin against it from a staging deployment, and check a few customers' **Finance → reconcile** (`GET /api/v1/customers/:id/reconcile` should report `ok: true`).
4. Point `MONGODB_URI` at the restored cluster and start `web`, then `worker`.
5. Outbox: messages that were `pending` at *T* will be sent when the worker starts. Review System status first and cancel/retry deliberately if a restore would resend stale booking emails (set them to `cancelled` in the `outboxmessages` collection).
6. Storage: if objects were deleted after *T*, restore their prior versions.

## Recovery limitations

- Point-in-time restores lose writes after *T* (payments recorded after *T* must be re-entered from the external receipts).
- Emails already delivered cannot be recalled; telephony call records come only from Twilio callbacks after restore.
- Derived balances are recomputed from ledgers only on demand (`reconcile`); a restore of a consistent snapshot keeps them consistent.

## Restore test

Not performed in this environment (no backup-enabled cluster was available). Before go-live, run the procedure above against a staging restore of a production snapshot and record the date, snapshot time, duration and reconcile results here.
