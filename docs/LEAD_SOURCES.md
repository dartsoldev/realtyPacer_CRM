# Leads and website lead sources

## Leads area

**Leads** in the main navigation. Requires `leads:read` and `leads:write`:

- Owners/admins have both.
- Staff can be granted them per user.
- Cleaners never have them.

- **Two categories, shown on separate tabs:**
  - **General / service**: requested service, preferred date, service location.
  - **Real estate**: buyer / seller / renter / other, area of interest, optional budget, optional listing link.
- **Category vs source:** category is what the person wants; source is where the lead came from.
  - The *source* is free text for manual entries, the source name for website forms, or "CSV import".
  - The *channel* (manual, CSV import, website form) is recorded separately.
- **Shared fields:** name, phone, optional email, city/address, received date, status (new → contacted → qualified → converted/lost), assigned staff member and notes. Every change goes into the lead's history.
- **Add lead**: enter a lead by hand.
- **Import CSV**:
  - Shows a preview first, then imports.
  - Re-importing the same rows adds nothing.
  - Columns are recognised by common names (Name, Phone, Email, City, Service, Preferred date, Intent, Area, Budget, Listing…).
- **Convert to customer**:
  - Lists existing customers with the same phone, email or name. Staff choose one, or create a new customer.
  - Creation is idempotent per lead, so a double click or retry never makes two customers.
  - The lead keeps its source and history, and the customer gets a note about where it came from.
  - For service leads, **Book a service** opens a new booking for that customer, prefilled with the preferred date.

## Website forms (server-to-server intake)

**Settings → Integrations → Website lead forms** (owner/admin).

1. **Add lead source**: create one per form (e.g. "Website – cleaning quote" as General/service, "Website – home valuation" as Real estate).
   - The key is shown **once**. Only its SHA-256 hash is stored. **New key** replaces it immediately.
2. Your website's **server** sends each submission:

   ```
   POST https://<APP_URL>/api/v1/intake/leads/<source id, e.g. src_…>
   Authorization: Bearer <source key>
   Content-Type: application/json            (or application/x-www-form-urlencoded)
   Idempotency-Key: <form entry id>          (optional; or map a submission-id field)

   {"submission_id":"1001","name":"Jordan Example","phone":"416-555-0100",
    "email":"jordan@example.com","city":"Mississauga","service":"Sofa cleaning",
    "preferred_date":"2026-11-02","message":"Two sofas"}
   ```

   Responses:

   | Code | Meaning |
   | --- | --- |
   | `201` | Created. |
   | `200` | Duplicate: the same submission id was already received, so nothing new was created. |
   | `401` | Unknown source, wrong key or paused source. |
   | `415` | Unsupported content type. |
   | `422` | A name and a phone or email are required. |
   | `429` | Rate limited; honour `Retry-After`. |

   - Bodies are limited to 32 KB.
   - Rate limits: 120 submissions per minute per source. When `TRUST_PROXY_HEADERS=true`, also 60 per minute per IP and 20 failed-key attempts per 15 minutes per IP.
3. **Field mapping**: map the form's own field names (e.g. `your-name`, `input_3`) to lead fields.
   - Common names work without mapping.
   - Unmapped fields are kept in the lead's notes, except anything named like a secret, token, key, password or captcha.
   - Values that don't validate (e.g. an unparseable phone or date) are kept in the notes rather than lost.
4. **Submission log**: shows the last 90 days of outcomes (accepted / duplicate / rejected / unauthorized / rate_limited).
   - Entries record the submission id and a short reason.
   - Never logged: keys, authorization headers or full payloads.

**Never put the key in browser JavaScript or HTML.**
- Submissions must come from your website's server, a form plugin's server-side webhook feature, or a relay such as Zapier or Make.
- Adding the website's URL to RealtyPacer does not import anything by itself.

### What is still needed to connect the real forms

For each form, tell us:

1. **Platform and tool:** which website platform and form tool it uses (e.g. WordPress + Contact Form 7 / Gravity Forms / WPForms / Elementor, Wix, Squarespace, Webflow, custom code).
2. **Webhook support:** whether that tool can send a server-side webhook with a custom `Authorization` header.
   - If it can't, a small relay is needed: a WordPress `functions.php` snippet, or Zapier/Make.
3. **Field names:** the form's field names (or a sample submission with fake data).
4. **Category:** whether the form is a service enquiry or a real estate enquiry.

### Not available

- Gmail inbox import, Meta (Facebook/Instagram) Lead Ads and property portals are **not** implemented. They are shown as "Not connected — not available".
- Leads from those channels can be entered manually, imported by CSV, or relayed to a website lead source.

### Verified so far

- Automated tests send a service lead and a real estate lead through the endpoint with a test key.
- They also check the duplicate retry, wrong key, rate limit and safe conversion.
- **No live website form has sent a lead yet.**
