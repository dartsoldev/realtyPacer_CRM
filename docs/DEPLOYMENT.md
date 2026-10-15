# Deploying RealtyPacer

One primary path: **a container image on a Linux host (or any container platform) behind a TLS reverse proxy**, using managed services for the data stores. Nothing here buys services, changes DNS or publishes anything; each step names what *you* must set up.

| Component | Required | What to use |
|---|---|---|
| Web app | yes | `realtypacer` image, `node server.js` (Next.js standalone, Node 22, non-root) |
| Background worker | yes, whenever booking emails are enabled or queued security emails must retry | same image, `node dist/worker.cjs` (one or more replicas) |
| MongoDB **replica set** | yes | MongoDB Atlas (M10+ for production backups), or self-hosted with `--replSet`. A standalone `mongod` is **not** enough: bookings, payments, credit and points use transactions. |
| SMTP provider | yes | Any provider with a verified sender domain (SPF, DKIM, DMARC) |
| Shared rate-limit store | — | Built in: counters live in MongoDB (`ratelimits`, TTL), shared by all instances. No Redis needed. |
| Private object storage | optional (photos/documents) | S3, Cloudflare R2, Backblaze B2, Wasabi… S3-compatible, public access blocked |
| Telephony | optional (browser calling) | Twilio Voice; default `CALLING_MODE=tel` needs nothing |

## 1. Build

```bash
docker build -t realtypacer:1.0.0 .
```

No secrets are needed at build time; all configuration is read at runtime. The image contains the web server (`server.js`), static assets and the operational CLIs in `dist/` (`worker.cjs`, `sync-indexes.cjs`, `bootstrap-superadmin.cjs`). `.env` files are excluded by `.dockerignore`.

Without Docker: `npm ci && npm run build && npm run build:cli`, then `node .next/standalone/server.js` (copy `.next/static` → `.next/standalone/.next/static` and `public` → `.next/standalone/public` first) and `node dist/worker.cjs`.

## 2. Configure

Create the secrets from [`.env.example`](../.env.example) in your platform's secret store (or a root-only `.env.production` next to `docker-compose.yml`, never committed). Production values:

- `APP_URL=https://realtypacer.com` and `NEXTAUTH_URL=https://realtypacer.com` (identical origins).
- `NEXTAUTH_SECRET`: 48 random bytes, base64url.
- `MONGODB_URI`: the replica-set URI with a dedicated database user (readWrite on the `realtypacer` database only).
- `TRUST_PROXY_HEADERS=true` only if your proxy overwrites `X-Forwarded-For`.

The web container validates configuration on start (`instrumentation.ts`) and exits with the names (never values) of missing variables.

## 3. Migrate (idempotent) and bootstrap

```bash
docker compose run --rm migrate                    # = node dist/sync-indexes.cjs
docker compose run --rm web node dist/bootstrap-superadmin.cjs --name "Owner Name" --email owner@realtypacer.com --org-name "Your Business"
```

`sync-indexes` creates/updates the declared indexes (and indexes for custom fields marked “indexed”). It never runs automatically on start. Run it on every release *before* switching traffic. The bootstrap prints a one-time setup link (72 h); open it, set a password, sign in. It refuses if a superadmin already exists.

## 4. Run

```bash
APP_VERSION=1.0.0 docker compose up -d web worker
```

- Health: `GET /api/v1/health` (liveness, no details) and `GET /api/v1/ready` (config + database; 503 otherwise). The image's `HEALTHCHECK` uses liveness.
- Graceful shutdown: containers receive `SIGTERM` (`init: true`, 30 s grace). The worker finishes its current batch; queued messages are claimed with a lease, so an interrupted send is retried.
- Scale the web tier horizontally; any number of workers may run (each message is claimed atomically).

## 5. DNS and TLS for realtypacer.com

1. Point `realtypacer.com` (A/AAAA) — and optionally `www` (CNAME) — at the host or load balancer.
2. Terminate TLS at the proxy. Example [Caddyfile](deploy/Caddyfile) (automatic Let's Encrypt certificates, redirects `www` → apex, forwards to `127.0.0.1:3000`).
3. The app sends HSTS (2 years, includeSubDomains) in production — enable it only once HTTPS works for every subdomain.

## 6. Trusted origin and callbacks

- `APP_URL` is the only origin accepted for state-changing API calls (Origin/Sec-Fetch-Site check) and the base of every link in emails.
- NextAuth callback: `https://realtypacer.com/api/auth/callback/credentials` (automatic; no third-party OAuth is used).
- Twilio (optional): TwiML App **Voice URL** `https://realtypacer.com/api/v1/telephony/twilio/voice` (POST). Status callbacks are set per call to `/api/v1/telephony/twilio/status`. Both validate `X-Twilio-Signature` against `APP_URL` — keep the public URL exact.

## 7. SMTP sender

Verify the sending domain with your provider (SPF include, DKIM keys, a DMARC policy), then set `EMAIL_FROM="RealtyPacer <no-reply@realtypacer.com>"`. TLS is required for non-local hosts. Check Admin → **System status** and send yourself a password reset to confirm delivery.

## 8. Storage policy (optional photos/documents)

- Create a **private** bucket: block all public access, no public ACLs, default encryption on, versioning on (see backups).
- IAM user/key limited to that bucket: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` (example [policy](deploy/s3-iam-policy.json)).
- CORS: allow `PUT` from `APP_URL` only with `content-type`/`content-length` headers ([example](deploy/s3-cors.json)). Browsers upload directly with 5-minute presigned URLs; downloads always go through the app (`/api/v1/attachments/:id/content`), which re-checks permissions.
- Set `S3_BUCKET`, `S3_REGION`, keys, and for non-AWS providers `S3_ENDPOINT` (+ `S3_FORCE_PATH_STYLE=true` if required). The CSP `connect-src` automatically allows that storage origin.

## 9. Browser calling (optional)

1. In Twilio: buy/verify a caller-ID number (your decision and cost), create an **API key** (standard), and a **TwiML App** with the Voice URL above.
2. Set `CALLING_MODE=browser`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_TWIML_APP_SID`, `TWILIO_CALLER_ID`, `CALLING_ALLOWED_COUNTRIES`.
3. Grant “Place calls from the browser” to staff who should use it (admins have it). Calls are limited to 30/hour per user and 300/day per organization, only to numbers stored on customer/cleaner records in allowed countries, and always show the configured caller ID.

With `CALLING_MODE=tel` (default) numbers open the device's phone app and nothing is sent to Twilio.

## 10. Releases and rollback

1. Build and tag a new image (`realtypacer:1.0.1`). Keep the previous tag.
2. Back up (Atlas: take an on-demand snapshot) before releases that change data shapes.
3. `docker compose run --rm migrate` with the **new** image (index changes are additive; old code tolerates new indexes).
4. `APP_VERSION=1.0.1 docker compose up -d web worker`, then watch `/api/v1/ready`, logs, and System status.
5. Rollback: `APP_VERSION=1.0.0 docker compose up -d web worker`. If a release dropped or changed indexes, re-run `migrate` with the old image. Data written by the newer version stays valid for the older one unless release notes say otherwise; restore from the snapshot only for data corruption (see [OPERATIONS.md](OPERATIONS.md)).

## Local development (separate from production)

`docker compose -f docker-compose.local.yml up -d` starts a single-node MongoDB replica set, Mailpit (SMTP sink, inbox at http://localhost:8025) and an S3 mock. Without Docker: `npm run dev:services` (in-memory replica set + SMTP sink). These are never production components.
