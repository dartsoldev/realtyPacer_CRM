# Google Calendar integration

**Settings → Integrations → Google Calendar** (owner/admin only, permission `integrations:manage`).

## What it does

- **Direction: outbound only — RealtyPacer → Google.** RealtyPacer stays the source of truth.
- Scheduled bookings get one event each in one chosen Google calendar.
  - Creating a booking creates the event.
  - Rescheduling, changing services or cleaners, or editing the address updates it.
  - Cancelling a booking deletes the event.
- **Event content:**
  - Title: services and customer name.
  - Location: the service address.
  - Description: the booking reference, status, services, assigned cleaners and a link to the booking. Opening the link requires signing in to RealtyPacer.
  - Not included: office notes, prices, payments, phone numbers or emails.
- Every request uses `sendUpdates=none` and adds no attendees. Customers and cleaners are never invited or emailed by Google.
- Events created in Google are **never** imported as customers, bookings or leads.
- When booking, staff see a warning if the chosen time overlaps a busy period in the connected calendar.
  - Only start and end times are read.
  - RealtyPacer's own events are ignored.
  - The warning is advisory and does not block saving.

## How syncing works (no push notifications)

- Each booking change is recorded in a queue (`CalendarSync`, one row per booking). The background worker (`npm run worker`) sends it, usually within a minute.
- **Retries** use backoff: 30 s, 2 min, 10 min, 30 min, then 2 h, for up to 6 attempts.
  - Failures appear under "Needs attention", with a **Retry failed** button.
- **Duplicates** are prevented by a deterministic event id (`rp<bookingId>`):
  - A repeated create becomes an update.
  - Each change carries a sequence number, so an older change can't overwrite a newer one.
- **Revoked or expired access** (`invalid_grant`) sets the status to "Reconnect needed". Pending changes are kept and sent after reconnecting.
- **Refresh strategy** (instead of Google push channels):
  - Once an hour the worker re-reads upcoming linked events.
  - Events edited or deleted in Google are flagged under "Needs attention". They are not imported.
  - **Retry** puts the CRM version back.
- This is not two-way sync and not instant.

## Security

- OAuth 2.0 web-server flow with PKCE.
  - The `state` value is single-use, expires after 10 minutes and is bound to the admin who started the flow.
- Refresh tokens are encrypted at rest with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`. Access tokens are never stored or logged.
- **Disconnect** revokes the token at Google and deletes the stored tokens. Events already in Google stay there.
- Scopes requested:
  - `openid` and `email`: show which Google account is connected.
  - `https://www.googleapis.com/auth/calendar.events`: create, update and delete events, and read busy times.
  - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`: choose the calendar.

## Setup (exact steps still required)

1. Open https://console.cloud.google.com/ and create or select a project.
2. Go to **APIs & Services → Library** and enable the **Google Calendar API**.
3. Go to **APIs & Services → OAuth consent screen** (also called "Google Auth Platform → Branding / Audience / Data access"):
   - User type: **Internal** if you use Google Workspace and only staff connect; otherwise **External**.
   - Fill in the app name (e.g. RealtyPacer), the support email and the developer contact.
   - Under Data access / Scopes, add `.../auth/calendar.events` and `.../auth/calendar.calendarlist.readonly` (plus `openid` and `email`).
   - In **Testing** mode, add the Google account(s) that will connect as test users.
     - Refresh tokens issued in Testing mode expire after 7 days. Publish the app (or use Internal) for production.
     - `calendar.events` is a sensitive scope, so publishing an External app may require Google verification.
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized redirect URI: `APP_URL/api/v1/integrations/google/callback`. For example:
     - production: `https://realtypacer.com/api/v1/integrations/google/callback`
     - local: `http://localhost:3000/api/v1/integrations/google/callback`
   - Copy the client ID and client secret.
5. Set the server environment (hosting secrets or `.env.local`; never commit it or paste it into chat):

   ```
   GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=…
   TOKEN_ENCRYPTION_KEY=<node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
   ```

6. Restart the web app **and** the worker.
7. Sign in as owner/admin and go to **Settings → Integrations**:
   - Click **Connect Google Calendar** and approve access.
   - Choose the calendar; a dedicated "RealtyPacer bookings" calendar is recommended.
   - Upcoming scheduled bookings (next 90 days) are then queued and sent by the worker.

## Verified so far

- Automated tests mock Google's HTTP API. They cover:
  - event create, update, cancel/delete and retry/backoff;
  - the duplicate (409) fallback;
  - `invalid_grant` → reconnect needed;
  - token encryption and single-use OAuth state.
- **No live Google account has been connected yet.** Real syncing is unverified until the steps above are completed and a test booking is checked in Google Calendar.
