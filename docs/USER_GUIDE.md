# RealtyPacer user and admin guide

## Roles and permissions

| Role | What they can do |
|---|---|
| **Superadmin** | Everything, including protected organization settings (name, timezone, currency, tax), and managing admins/superadmins. The last active superadmin can't be demoted or suspended. |
| **Admin** | All operational work (customers, services, bookings, cleaners, calendar, prices, payments, refunds, billing, reports/exports, shared views, custom fields, loyalty, calls incl. browser calling, booking emails, imports, files) plus inviting/managing staff and cleaners, organization settings and System status. |
| **Staff** | By default: view customers, services, bookings and calendar, add notes, log calls, view files. Everything else is granted per person in Users (e.g. “Record payments”, “View reports”, “Import customers”). |
| **Cleaner** | No leads, integrations, customer filter or financial reports. Only their own assigned jobs: customer name/phone, job address with map link and access notes, services, instructions, before/after photos; start and complete jobs. Never sees the customer directory, office notes, prices, payments, reports or other cleaners' jobs. |

Permissions are checked on the server for every page and API call; hiding a button is never the only protection.

## Daily office workflow

1. **Find the customer** — Customers: search by name, any part of a phone number, or email. Open the profile for history, addresses (with map and listing links), notes, calls, finance and points.
2. **Call** — tap the number (opens your phone app) or copy it; then **Log call** to record direction, outcome, duration and notes. With browser calling enabled, **Call in browser** uses your microphone and the organization's number; the outcome comes from the phone network.
3. **Book** — *Create booking* from the profile, Bookings, Calendar (click a time) or the dashboard. Pick or create the customer and address, add services, choose cleaners (double-booking is refused with the conflicting job shown), add instructions (cleaner-visible) and office notes (internal).
4. **Calendar** — day/week/month/agenda in the organization's timezone, filtered by cleaner, status or city.
5. **Reschedule** — Edit on the booking. If someone else changed it meanwhile you'll be asked to reload instead of overwriting their change. Assigned cleaners get an in-app notification.
6. **Complete** — Start/Complete on the booking (cleaners can do this from My jobs).
7. **Charge and get paid** — Booking → Billing: optional discount, **Finalize charges** (creates the amount owed; tax only if configured). **Record payment** for money received by cash, e-Transfer, cheque or an external card terminal — RealtyPacer never charges cards. Unapplied money stays as credit; apply it later from the receipt.
8. **Corrections** — credits/extra charges are adjustments with a reason; refunds are recorded after the money was returned; a mistaken receipt is reversed (kept in history).
9. **Review** — Customer → Finance (lifetime totals with their formulas), Payments, and Reports.

## Where to find things (October 2026 refinement)

| Task | Where |
|---|---|
| See everything about one customer | **Customers → (name)**. Top: Call button, phone, email, address with map link and **Edit address**. Overview: completed bookings vs. completed services, service days, upcoming, total actually paid, points balance with **Adjust points**, upcoming bookings, notes and custom details (**Edit**). **Service history** tab: Date · Service · Service address · Amount paid · Cleaner · Status, one row per service. |
| Who had which service where | **Customer filter** (main menu, also on the dashboard). **Add filter** (e.g. Service city is Mississauga, then Service is Sofa cleaning); separate filters must all match, several values in one filter mean "any of". Cards above the table total the whole result (customers, bookings, services, paid toward the matching services), not just the visible page. **Select columns** adds phone, email, current customer city, tags, points or custom fields. Only completed jobs count unless you add a Booking status filter. |
| Custom fields | **Administration → Custom fields**: Text, Number, Date, Dropdown, Checkbox (and a few more). Renaming keeps the data. Points and money totals are calculated by the system and can't be custom fields. |
| Book a job | **New booking**: type a customer's name or phone; **Create new customer** keeps what you already entered. Type a cleaner's name to assign; with nobody chosen the job is clearly marked **Unassigned**. If Google Calendar is connected, busy times there are shown as a warning. |
| Calendar | Events show customer, service, city, time, cleaner and status. Opening a booking shows **← Back to calendar** that returns to the same day and view; from the booking you can open the customer and each cleaner. |
| Calling | **Call** opens your phone's dialer (or browser calling when configured); **Copy** copies the number. Opening the dialer is not recorded as a completed call — use **Log call** afterwards. |
| Leads | **Leads**: General / service and Real estate tabs, **Add lead**, **Import CSV**, status, assignment, notes, **Convert to customer** (checks existing customers first) and **Book a service**. See docs/LEAD_SOURCES.md. |
| Integrations | **Administration → Integrations**: Google Calendar (outbound only) and website lead forms. See docs/GOOGLE_CALENDAR.md and docs/LEAD_SOURCES.md. |

Cleaners need a name and phone number (email optional) and get no sign-in unless invited.

## Reports

Choose a mode (Service performance, Customer summary, Cash received), a date range (presets or custom, organization timezone) and job statuses, then add conditions: all conditions must match; several values inside one condition match any of them (e.g. *City is any of Mississauga, Toronto* AND *Service is Sofa cleaning*). Totals cover exactly the matched rows. Save views (private, or shared if allowed) and **Export CSV** (all matching rows, with a metadata header).

## Cleaners

- Cleaners sign in only after being invited from their profile (*Invite to sign in*); a cleaner profile alone grants no access.
- **My jobs** lists today's and upcoming assigned jobs with call and map buttons. Notifications (bell) show new assignments, removals, time changes and cancellations.

## Administration

- **Users**: invite by email (link valid 72 h), change roles (within your authority), grant staff permissions, suspend (signs the person out everywhere), resend invitations.
- **Organization**: business details, labels, sales tax (superadmin), customer booking emails (off / manual / automatic).
- **Custom fields**: add fields to customers, bookings or cleaners; rename or archive without losing data; booking fields can be visible to assigned cleaners.
- **Import customers**: Customers → Import. Download the template, upload a CSV (≤ 2 MB, ≤ 5,000 rows), match columns, review errors and possible duplicates (same phone or email) and choose create / skip / update for each. Updates only fill blank fields unless you tick fields to overwrite. Payments and balances are never imported this way.
- **System status**: whether database, email, storage, worker and calling are working; failed emails with Retry.
- **Audit history**: administrative and security events.

## Installing on a phone

Open RealtyPacer in the phone's browser and choose *Add to Home Screen* (Safari) or *Install app* (Chrome). It opens like an app but is the same website: it needs a connection, stores no customer data offline, and doesn't queue changes while offline.
