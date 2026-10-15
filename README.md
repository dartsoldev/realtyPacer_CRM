# RealtyPacer

CRM for cleaning and service businesses — realtypacer.com.

Customer → address → booking → service items → cleaner assignment → job completion → charges/payments → reporting, plus calling, notifications, customer import, private photos/documents, custom fields, saved views, loyalty points and role-based access. Status, decisions and definitions: [PROJECT_STATE.md](PROJECT_STATE.md). Release checklist: [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

| Guide | |
|---|---|
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Roles, daily workflows, administration |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | API architecture, modules, integrations, security headers |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Container deployment, DNS/TLS, SMTP, storage, calling, rollback |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Logging, monitoring, background jobs, backup and restore |

RealtyPacer does **not** process card or online payments, send refunds, or record calls. Payments are records of money received elsewhere; browser calling is optional (Twilio) and off by default.

## Stack

Next.js 16.4.1 (App Router, Node runtime) · React 19.3 · TypeScript · MongoDB (replica set) with Mongoose 9 · next-auth 4.24.15 (credentials, JWT cookie) · Argon2id · Nodemailer 10 (SMTP) · Zod 4 · Tailwind CSS 4 · FullCalendar 6.1.21 · Twilio Voice (optional) · S3-compatible storage via AWS SDK v3 (optional) · sharp (thumbnails) · Vitest 5. Node.js ≥ 20.9 (developed on 22).

## Local setup

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill in `.env.local` (all variables are documented in [.env.example](.env.example)). For a fully local setup without any accounts:

```bash
npm run dev:services
```

(in-memory MongoDB **replica set** on `127.0.0.1:27027` and an SMTP sink writing to `.dev-mail/`; use the MongoDB URI it prints) — or, with Docker, `docker compose -f docker-compose.local.yml up -d` (MongoDB replica set, Mailpit, S3 mock).

```bash
npm run db:indexes
```

```bash
npm run bootstrap:superadmin -- --name "Your Name" --email you@example.com --org-name "Your Business"
```

```bash
npm run dev
```

Open http://localhost:3000 and use the one-time setup link the bootstrap printed. Optional background worker (needed for booking emails and email retries):

```bash
npm run worker
```

Optional synthetic sample data for a development organization: `npm run dev:fixtures -- --org-id <id> --yes`. A synthetic customer CSV for trying the importer is in [docs/samples/customers-sample.csv](docs/samples/customers-sample.csv).

### Troubleshooting

- **"Setup required"** — a required variable is missing or invalid (often `NEXTAUTH_SECRET` shorter than 32 characters). The page lists variable names, never values.
- **PowerShell drops `--`** in `npm run bootstrap:superadmin -- …`; the script recovers the flags, or run `npx tsx --conditions=react-server scripts/bootstrap-superadmin.ts --name "…" --email …`.
- **Bookings/payments fail to save** — MongoDB is not a replica set (transactions are required).
- **Gmail SMTP** — `smtp.gmail.com`, 587, `SMTP_SECURE=false`, the Gmail address as user and a 16-character App Password.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | Develop / production build / run the build |
| `npm run worker` (`npm run start:worker` after `build:cli`) | Background worker (email outbox, upload clean-up) |
| `npm run build:cli` | Bundle worker and ops CLIs into `dist/` |
| `npm run db:indexes` (= `db:migrate`) | Create/update indexes — idempotent, run per release |
| `npm run bootstrap:superadmin` | First superadmin (invite link or hidden password prompt) |
| `npm run typecheck` · `npm run lint` · `npm test` | Static checks and unit/integration tests |
| `npm run test:e2e` | End-to-end suite against the production build (`npm run build && npm run build:cli` first) |
| `npm run check` | typecheck + lint + test + build |

Tests use an in-memory MongoDB replica set, or `TEST_MONGODB_URI` (any replica set; each run creates and drops a random `realtypacer_test_*` / `realtypacer_e2e_*` database), a local SMTP server, in-memory object storage and mocked Twilio signatures — no real email, storage or calls.

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): `docker build`, `docker compose run --rm migrate`, bootstrap, `docker compose up -d web worker`, TLS proxy for realtypacer.com, and rollback.
