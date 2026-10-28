# Backend

Express 4 + Mongoose API for the hackathon dashboard (the **E** and **M** of our
MENN stack). Plain, old-style JavaScript — dynamically typed, with JSDoc used to
*document* params but no enforced type-checking. This platform is white-label
(set `ORG_NAME`). See [`../README.md`](../README.md) and
[`../AGENTS.md`](../AGENTS.md) for conventions.

## Setup

```bash
cd Backend
cp .env.example .env      # then edit values
npm install
npm run dev               # node --watch server.js
```

You need a MongoDB instance (local `mongod` or a MongoDB Atlas URI in
`MONGODB_URI`). Google OAuth, email (nodemailer), and resume uploads (Azure Blob)
are optional — each degrades gracefully until its env vars are filled in. For
email, see [Setting up email](#setting-up-email).

## Creating the first admin

There is no admin until you make one:

1. Register a normal account through the app.
2. Set `SETUP_ADMIN=true` in `.env` and restart.
3. `curl -X POST localhost:4000/api/auth/setup-admin -H 'Content-Type: application/json' -d '{"email":"you@example.com"}'`
4. Set `SETUP_ADMIN=false` and restart. (It refuses once any admin exists.)

## Setting up email

The dashboard emails applicants when they submit, when they're accepted or
rejected (with their check-in QR code), when they check in, to verify their
email address on sign-up, and for password resets. Until email is set up those
emails are skipped, and password-reset and verification links are only printed
in the server log.

**Email verification** is enforced only while email is set up (a link nobody
can receive would lock everyone out of applying): new password sign-ups must
click the emailed link before they can apply. See [Email
verification](#email-verification).

The simplest setup is a dedicated Gmail account for your hackathon (for
example `donotreply.yourhackathon@gmail.com`):

1. **Create the Gmail account** and sign in to it.
2. **Turn on 2-Step Verification** at
   [myaccount.google.com/security](https://myaccount.google.com/security).
   Google requires it before it allows app passwords.
3. **Create an app password** at
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   (name it e.g. "Dashboard"). Copy the 16 characters. The account's normal
   password won't work here.
4. **Run the setup script** on the server, from `backend/`:

   ```bash
   npm run setup-email
   ```

   It asks for the Gmail address, the sender name recipients see (defaults to
   `ORG_NAME`), the app password (hidden as you type) and, optionally, an
   address to send a test email to. It checks the login and sends the test
   email *before* saving anything to `.env`, so a typo can't break email that
   already works. Re-run it any time to change the account or password.
5. **Restart the backend.** Or let the script do it with
   `RESTART_CMD="<your restart command>" npm run setup-email`, e.g.
   `RESTART_CMD="sudo systemctl restart <service>"`.

Good to know:

- **Limits:** a personal Gmail account can send about **500 emails a day**.
  Going over pauses sending for up to 24 hours. If you'll decide on more
  applicants than that, spread acceptance and rejection emails over several
  days. Emails that fail are retried and listed in the
  [email outbox](#email-outbox).
- **Replies** go to the sending account, so check it or say "do not reply" in
  your email templates (admin dashboard → email templates).
- **Google Workspace accounts can't use app passwords for this** (Google
  removed password sign-in for apps in 2025). Use a personal Gmail account,
  or another provider's SMTP server: set `SMTP_HOST` / `SMTP_PORT` when you
  run the script.

## Email outbox

Every email the server sends is logged (collection `emaillogs`, schema
`schemas/emailLog.js`) so failures are visible and nothing is lost when SMTP
hiccups. Admins see it at `/dashboard/admin/outbox` (API: `/api/admin/outbox`).

- **Sending:** `utils/mailer` writes a row (`queued`), tries the send right
  away and resolves or rejects with that first attempt, exactly as before, so
  fire-and-forget callers and callers that await and tell staff both work.
  Callers that report the failure themselves pass `{ retry: false }` so it
  isn't also retried behind the person's back.
- **Retries:** a failed send stays `queued` and an in-process worker
  (started in `server.js`; no new infrastructure) tries it again after 1 min,
  5 min, 30 min, 2 h, 6 h, then marks it `failed` (6 attempts). A permanent
  SMTP error (unknown mailbox) fails at once. After 3 transient failures in a
  row the worker pauses for 5 minutes instead of burning every queued email's
  attempts during an outage.
- **No double sends:** each attempt first *claims* the row with one atomic
  update, so the worker, another server instance and a double-clicked
  "resend" can't all send it. If the server dies mid-send the row becomes
  `failed` ("may have been delivered") and is never resent automatically.
  Sending a copy of an already-sent email needs `{ "again": true }`.
- **What is stored:** recipient, template key, the placeholder values (so a
  retry renders the same email from the current template), subject, status
  and errors. Never attachments (the check-in QR is redrawn from the address)
  and never single-use links: password-reset and account-setup emails are
  logged `redacted` with no values, aren't retried, and "resend" on an
  account-setup row issues a **new** link (password resets are refused: the
  person asks again). Rows delete themselves after 90 days (TTL index).
- **Bulk email:** `POST /api/admin/outbox/bulk` sends a stored template to a
  segment (not applied, started-but-not-submitted, pending, accepted,
  waitlisted, rejected, checked in, "test: just me"). Workshop sign-ups and
  hardware holders are listed as unavailable until those features exist. The
  emails are queued and sent one at a time; `dryRun` counts first;
  `POST /api/admin/outbox/cancel-queued` stops a send. `resend-acceptance`
  re-sends the acceptance email (with the QR) to accepted applicants who have
  no sent one logged.
- **Consent:** `User.marketingEmailConsent` is off by default (sign-up,
  `PATCH /api/auth/me`, or the public application form can set it). Bulk
  sends are `announcement` by default: only opted-in people get them, each
  with an unsubscribe link (`/unsubscribe` page, `POST /api/auth/unsubscribe`,
  `List-Unsubscribe` header), and consent is checked again right before each
  send. Pass `category: "transactional"` for things people need (it ignores
  consent), e.g. re-sending acceptance emails.
- **Daily limit:** bulk sends and "retry all" refuse to go over
  `EMAIL_DAILY_LIMIT` emails per rolling 24 h (default 500, the personal Gmail
  limit; `0` turns the check off) unless the request has
  `"allowOverLimit": true`.

Optional environment variables:

| Variable                  | Default | Meaning                                       |
| ------------------------- | ------- | --------------------------------------------- |
| `EMAIL_DAILY_LIMIT`       | `500`   | Sending-account limit per 24 h; `0` = no check |
| `EMAIL_MIN_INTERVAL_MS`   | `1000`  | Gap between the starts of two sends, so bursts stay under the provider's per-second limit; `0` = off |
| `EMAIL_RETRY_INTERVAL_MS` | `30000` | How often the retry worker looks for due emails |
| `EMAIL_LOG_RETENTION_DAYS`| `90`    | How long outbox rows are kept                 |

## Technical settings

Admins can see and change the server's environment variables from
Dashboard > Technical settings (`/dashboard/admin/system`). The registry of
every variable (label, group, help, secret, editable, restart needed,
validator) is `utils/systemConfig.js`.

- **Storage:** values, including secrets, live only in the server's `.env`
  file. There is no database copy or encryption. The page is write-only: it
  reports Set/Not set and env/default/unset, never a value or secret hint.
- **File path:** set `ENV_FILE_PATH` in the service environment before startup
  to select another dotenv file; otherwise the server loads and edits
  `path.resolve(process.cwd(), ".env")`. Set it before launching tests too:
  tests use disposable files, never the deployment's `.env`.
- **Saving:** the whole batch is validated before any write. Saves are serialized
  within the server process, preserve unrelated lines and comments, and replace
  the file atomically with its existing permissions (0600 for a new file).
  Before replacement the current file is copied to `.env.previous` (or
  `<ENV_FILE_PATH>.previous`), overwriting the prior backup. This backup contains
  secrets too. Remove deletes the key's lines and unsets it in `process.env`;
  a built-in default applies where available. Other changes update `process.env`
  immediately. Manual edits take effect after a restart. Quoting follows the
  installed dotenv parser: it does not unescape `\\` or `\"`, so the writer
  chooses a quote delimiter that round-trips without added escapes. Values
  that cannot round-trip are rejected before any write.
- **Read-only:** `MONGODB_URI`, `PORT`, `NODE_ENV`, `JWT_SECRET`,
  `JWT_EXPIRES_IN`, `SETUP_ADMIN`, `ALLOW_SELF_RESTART`, `CLIENT_ORIGIN`,
  `TRUST_PROXY`. Change these on the server to avoid dashboard lockouts.
- **Restart:** settings read only at startup (rate limits, Google credentials,
  `EMAIL_RETRY_INTERVAL_MS`, `AUTO_ACCEPT_INTERVAL_MS`) are marked
  `restartRequired`. With
  `ALLOW_SELF_RESTART=true` the Restart button closes the HTTP server and exits
  with code 0 so the service manager starts it again; this needs
  `Restart=always` in the systemd unit. Without it the API answers `409` and
  the change waits for a manual restart.
- With more than one server instance, each instance picks up a saved value when
  it restarts.
- `CLIENT_ORIGIN` and `TRUST_PROXY` are read-only to prevent dashboard lockouts.
  Email pacing (`EMAIL_MIN_INTERVAL_MS`) takes effect immediately; automatic
  acceptance timing (`AUTO_ACCEPT_INTERVAL_MS`) needs a restart.

## Scripts

| Command               | What it does                                  |
| --------------------- | --------------------------------------------- |
| `npm run dev`         | Start with auto-reload                        |
| `npm start`           | Start once                                    |
| `npm run setup-email` | Set up outgoing email (see "Setting up email") |

## Layout

```
server.js          entry point; mounts global parseToken at the top
config/db.js       Mongoose connection
data/              colleges.csv + programming/hardware skills JSON
schemas/           User, Application, ApplicationRound, OrgSettings, Team, EmailLog
utils/             parseToken (global), isAuthenticated/isModerator/isAdmin,
                   isEmailVerified, signToken, passport (Google), mailer,
                   emailVerification, azureBlob, googleStatus,
                   requireFeature + features (module flags), branding,
                   orgSettingsCache, imageType, orgLinks, applicationStatus,
                   waitlist, applicationFlags, resumeText, outbox (email log +
                   retries), emailSegments, unsubscribe
controllers/       auth, application, admin, settings, meta, branding, stats, export,
                   public logic
routes/            express.Router() tables (auth, applications, admin, exports, meta,
                   public)
```

## Roles

- `applicant` (default) — can only apply.
- `moderator` — reviews applications (list + accept/reject/waitlist); later,
  hardware & judging views.
- `admin` — everything, plus org setup (settings, rounds, promoting users).

Guards: `isAuthenticated`, `isModerator` (moderator **or** admin), `isAdmin`.

## API

Base prefix: `/api`. All responses are JSON. Errors: `{ error }`.
Send `Authorization: Bearer <token>`; `parseToken` decodes it onto `req.user`.
\* Only while an admin has turned on "Accept applications without an account"
(org setting `publicApplications`); 404 otherwise. Such applicants get a
passwordless account that can't log in until they set a password from the link
emailed on acceptance (or via "Forgot password").

| Method | Path                            | Auth      | Purpose                                |
| ------ | ------------------------------- | --------- | -------------------------------------- |
| GET | `/api/hardware?q=&category=` | accepted user | Inventory availability and facilities; no borrower identities |
| GET | `/api/hardware/mine` | accepted user | Own open and returned hardware with deadlines |
| GET | `/api/staff/hardware` | moderator | Inventory and facilities |
| GET | `/api/staff/hardware/checkouts?itemId=&userId=&qrId=&open=1&overdue=1` | moderator | Borrower lookup, item history or outstanding loans, overdue first |
| POST | `/api/staff/hardware/checkouts` | moderator | Checkout `{ qrId or userId, itemId, dueAt?, notes? }`; accepted and event checked-in required |
| POST | `/api/staff/hardware/checkouts/:id/return` | moderator | Idempotent return; retains history |
| GET | `/api/staff/hardware/export.csv?kind=inventory` | moderator | Inventory CSV; omit kind for complete checkout history |
| POST | `/api/staff/hardware/reminders` | moderator | Background return reminders for open loans; optional `{ itemId }` |
| GET | `/api/admin/hardware` | admin | Inventory and facilities |
| POST | `/api/admin/hardware/items` | admin | Create inventory item |
| PATCH | `/api/admin/hardware/items/:id` | admin | Edit item; adjusts available stock by total quantity delta |
| DELETE | `/api/admin/hardware/items/:id` | admin | Archive item only when all stock is on hand; preserves history |
| POST | `/api/admin/hardware/import` | admin | `{ csv, preview }`; preview defaults true; false imports validated rows as new items |
| GET | `/api/admin/hardware/labels` | admin | Printable item QR data URLs with `hardware:<itemId>` payload |
| POST | `/api/admin/hardware/facilities` | admin | Create `{ name, location, accessNotes }` |
| PATCH | `/api/admin/hardware/facilities/:id` | admin | Edit facility |
| DELETE | `/api/admin/hardware/facilities/:id` | admin | Remove facility |
| GET    | `/api/health`                   | public    | Liveness check                         |
| GET    | `/api/health/db`                | public    | Database check: 200 up / 503 down      |
| POST   | `/api/auth/register`            | public    | Create applicant (valid email required, 400 otherwise), return JWT, email a verification link |
| POST   | `/api/auth/login`               | public    | Log in, return JWT                     |
| POST   | `/api/auth/verify-email`        | public    | Consume the emailed link `{ token }`, mark the email verified |
| POST   | `/api/auth/resend-verification` | user      | Email a new verification link (rate-limited, 1/min per account) |
| POST   | `/api/auth/forgot-password`     | public    | Email a reset link                     |
| POST   | `/api/auth/reset-password`      | public    | Consume token, set new password        |
| GET    | `/api/auth/google`              | public    | Start Google OAuth (if enabled)        |
| GET    | `/api/auth/google/callback`     | public    | OAuth callback → redirect with token   |
| POST   | `/api/auth/setup-admin`         | env-gated | Bootstrap first admin (`SETUP_ADMIN`)  |
| GET    | `/api/auth/me`                  | user      | Current user                           |
| POST   | `/api/auth/unsubscribe`         | public    | Turn announcement emails off (link token) |
| PATCH  | `/api/auth/me`                  | user      | Set `marketingEmailConsent`            |
| POST   | `/api/applications`            | user, verified email | Create/update application (multipart); 403 `EMAIL_NOT_VERIFIED` until verified |
| GET    | `/api/applications/me`          | user      | Open round + your application, plus `latest`: your standing across all rounds (status, round name, `checkedIn`) |
| GET    | `/api/applications/public/round` | public*  | Open round + form, for applying without an account |
| POST   | `/api/applications/public`      | public*   | Apply without an account (multipart, `email` + fields) |
| GET    | `/api/applications/me/resume`   | user      | 5-min signed link to your resume       |
| GET    | `/api/meta/config`              | public    | Org name + Google-enabled flag         |
| GET    | `/api/meta/branding`            | public    | Runtime branding + module flags (cached ~60 s) |
| GET    | `/api/meta/branding/files/:file` | public   | An uploaded logo / favicon (see "Branding") |
| GET    | `/api/meta/links`               | user      | Website, Discord and mentorship links  |
| GET    | `/api/meta/colleges?q=`         | public    | University autocomplete                |
| GET    | `/api/meta/skills/programming?q=` | public  | Programming-skill autocomplete         |
| GET    | `/api/meta/skills/hardware?q=`  | public    | Hardware-skill autocomplete            |
| GET    | `/api/admin/applications`       | moderator | List applications (`?status=&round=&flagged=true`) + `flaggedCount` |
| GET    | `/api/admin/applications/:id`   | moderator | One application in full (answers, round form, flag reasons) |
| PATCH  | `/api/admin/applications/:id`   | moderator | Decide (`{ decision }`); accept, reject and waitlist email the applicant |
| POST   | `/api/admin/applications/:id/flag` | moderator | Flag for a closer look (`{ reason }`)  |
| DELETE | `/api/admin/applications/:id/flag` | moderator | Clear the flag and its reasons         |
| GET    | `/api/admin/applications/:id/resume` | moderator | 5-min signed link to its resume   |
| GET    | `/api/admin/users?q=`           | admin     | Search users                           |
| PATCH  | `/api/admin/users/:id/role`     | admin     | Set role (`applicant/moderator/admin`) |
| GET    | `/api/admin/rounds`             | admin     | List rounds                            |
| POST   | `/api/admin/rounds`             | admin     | Create round                           |
| PATCH  | `/api/admin/rounds/:id`         | admin     | Update round (dates, open, formConfig, `waitlistAfterAccepted`) |
| DELETE | `/api/admin/rounds/:id`         | admin     | Delete round                           |
| GET    | `/api/admin/outbox`             | admin     | Email log (`?status=&template=&q=&page=`) + counts |
| GET    | `/api/admin/outbox/segments`    | admin     | Bulk-email audiences + sending limit   |
| POST   | `/api/admin/outbox/bulk`        | admin     | Queue a template to a segment (`dryRun` counts) |
| POST   | `/api/admin/outbox/resend-acceptance` | admin | Re-send acceptance emails with QR (`dryRun`) |
| POST   | `/api/admin/outbox/retry-failed` | admin    | Requeue failed emails worth retrying   |
| POST   | `/api/admin/outbox/cancel-queued` | admin   | Cancel queued emails (`{ batchId? }`)  |
| GET    | `/api/admin/outbox/:id`         | admin     | One log row                            |
| POST   | `/api/admin/outbox/:id/resend`  | admin     | Retry / resend one (`{ again }` for sent) |
| POST   | `/api/admin/outbox/:id/cancel`  | admin     | Cancel a queued email                  |
| GET    | `/api/admin/settings`           | admin     | Org settings (+ Google env status)     |
| PATCH  | `/api/admin/settings`           | admin     | Update settings (Google toggle, `autoFlagApplications`, `features`, `branding`) |
| GET    | `/api/admin/system-config`      | admin     | Technical settings: set/unset status and source only; no values are returned |
| PATCH  | `/api/admin/system-config`      | admin     | Save `{ values: { KEY: "value" | null } }` (all validated first; `null` removes the key from `.env`) |
| POST   | `/api/admin/system-config/restart` | admin  | Restart the service (`202`), only when `ALLOW_SELF_RESTART=true`, else `409`; 3 per minute |
| PUT    | `/api/admin/branding/:slot`     | admin     | Upload `logo` / `logo-dark` / `favicon` (multipart `file`) |
| DELETE | `/api/admin/branding/:slot`     | admin     | Remove that image (back to the server default) |
| GET    | `/api/admin/stats`              | admin     | Application + event-day statistics (`?round=&status=`) |
| GET    | `/api/admin/exports/applications.csv` | admin | Applications CSV, answers flattened (`?round=&status=`) |
| GET    | `/api/admin/exports/checkins.csv` | admin   | Check-ins CSV (who, when, by whom, forced)  |
| GET    | `/api/admin/exports/meals.csv`  | admin     | Meals CSV with served counts           |
| GET    | `/api/admin/exports/resumes.zip?consentKey=` | admin | ZIP of resumes of accepted applicants who ticked that checkbox question (`&round=`) |
| GET    | `/api/admin/schedule` (+ POST/PATCH/DELETE) | admin | Run of show; `published` puts an item on the public feed |
| GET    | `/api/public/schedule`          | public    | Published run of show as JSON (cached, CORS `*`) |
| GET    | `/api/public/schedule.ics`      | public    | The same as an iCalendar file          |

Exports are admin-only, never cached, streamed in batches, and defanged against
spreadsheet formula injection (`utils/csv.js`); they never contain password
hashes, tokens, QR codes or resume blob names. `/api/public/*` is the only part
of the API that answers any website's browser (open CORS, no credentials); it
only exposes what an admin published.

## Feature flags (modules on/off)

Admins can switch whole modules off at runtime: `meals`, `hardware`,
`workshops`, `judging`, `raffle` (`OrgSettings.features`, all **on** by
default). Edit them with `PATCH /api/admin/settings`:

```json
{ "features": { "meals": false } }
```

Only the keys you send change; values must be real booleans (`"false"` is
rejected, not coerced) and unknown keys are a 400. The flags are also in the
public `GET /api/meta/branding` so the nav can hide disabled modules.

**Gating a module's routes.** `utils/requireFeature("<key>")` answers **404**
to everyone while the feature is off, admins included, so a disabled module
can't be half-used. A missing flag counts as ON (older settings documents,
modules added later), so it can never lock anyone out or crash a request.

> **Every router of a flag-gated module MUST mount `requireFeature`**, before
> its auth guards, or the module keeps answering while "off". Today:
> `meals` is mounted on `/api/admin/meals` and `/api/staff/meals`. Hardware gates
`/api/hardware`, `/api/staff/hardware` and `/api/admin/hardware`. The
> remaining flags default on and gate nothing yet; when their modules land, mount
> them the same way (`router.use("/hardware", requireFeature("hardware"))`) and
> add a test that a disabled module 404s for admin, moderator and anonymous
> callers. To add a new flag, add it to `utils/features.js` (keys + label).

## Branding (runtime, no rebuild)

`GET /api/meta/branding` (public, `Cache-Control: public, max-age=60`, with an
ETag) returns what the frontend needs to theme itself:

```json
{
  "branding": {
    "orgName": "…", "primaryColor": "#4f46e5", "secondaryColor": "#64748b",
    "accentColor": null, "logoUrl": null, "logoDarkUrl": null, "faviconUrl": null
  },
  "features": { "meals": true, "hardware": true, "workshops": true, "judging": true, "raffle": true }
}
```

Each branding field resolves **admin setting → server env → built-in default**,
and the env is read on each request, so one image serves every hackathon.
`accentColor` and the images are `null` when unset (the frontend derives the
accent and falls back to the org name as text). Env: `ORG_NAME`,
`BRAND_PRIMARY`, `BRAND_SECONDARY`, `BRAND_ACCENT`, `BRAND_LOGO_URL`,
`BRAND_LOGO_DARK_URL`, `BRAND_FAVICON_URL` (see `.env.example`). Admins edit
the same fields with `PATCH /api/admin/settings`:

```json
{ "branding": { "primaryColor": "#0f766e", "orgName": "My Hack", "logoUrl": "https://…" } }
```

- Colours must be exactly `#RRGGBB` (stored lower-case); anything else, such as
  `#fff`, `red`, `rgb()` or CSS fragments, is a 400. Raw CSS is never passed
  through, and neither is a bad value found in the environment or database.
- `""` or `null` clears a field back to the server default. Nothing is saved
  if any field in the request is invalid.
- Image URLs set by an admin must be `https://`. Env URLs may be `http://`.
- The organisation name here (and in `GET /api/meta/config`) is for the UI.
  Emails keep using the `ORG_NAME` env var.

**Logo upload.** `PUT /api/admin/branding/logo|logo-dark|favicon` takes a
multipart `file` (max 1 MB). The type is read from the file's bytes: PNG, JPEG
or WebP (also ICO for the favicon). **SVG is refused**, because SVG can carry
script. A new upload replaces the previous file or pasted URL for that slot;
`DELETE` on the same path removes both. Needs `AZURE_STORAGE_CONNECTION_STRING`
(otherwise 501; pasting an image URL still works).

*Why files are served by the API, not from a public container.* Resumes use
a private container with short-lived signed links, and logos must be readable
by anonymous visitors. Rather than a public container (which needs anonymous
blob access enabled on the whole storage account) the logos go in a second,
**also private** container (`AZURE_STORAGE_BRANDING_CONTAINER`, default
`branding`) and the API serves them at `GET /api/meta/branding/files/<name>`.
That route only accepts names the API generated (`logo-<16 hex>.png`, …),
re-checks the bytes against the extension, and sends `Content-Type` from that
extension with `X-Content-Type-Options: nosniff` and a locked-down CSP. Every
upload gets a fresh random name, so the files are cached `immutable` for a
year. With `API_PUBLIC_URL` set the branding response has absolute links;
without it they are root-relative paths (`/api/meta/branding/files/…`) that the
frontend resolves against its API URL. (The link is never built from the
request's Host header: the response is shared-cacheable.)

**Cost on Cosmos DB.** `utils/orgSettingsCache` keeps the settings document in
memory per instance (`SETTINGS_CACHE_TTL_MS`, default 10 s), shares one query
between concurrent requests, serves the last good copy if a refresh fails, and
uses a plain read (no upsert). Admin saves clear it on the instance that
handled them; other instances catch up within the TTL, and browsers/CDNs within
the extra 60 s of `max-age`. So a change shows up within about 70 s.

## Community links (mentorship)

Mentorship tickets are created on Discord, so the dashboard only links to them.
`GET /api/meta/links` (login required) returns `{ links: { websiteUrl,
discordUrl, mentorshipUrl } }` from `ORG_WEBSITE_URL`, `ORG_DISCORD_URL` and the
optional `ORG_DISCORD_MENTORSHIP_URL`, read on each request. Unset or anything
that isn't a plain http(s) URL comes back as `null`.

## Email verification

Password sign-ups (`POST /api/auth/register`) start with `emailVerified: false`
and get a link (`/verify-email?token=...`, built-in `verify_email` template,
single use, valid 24 hours). Only a SHA-256 hash of the token is stored, like the
password-reset token. The frontend page POSTs it to `/api/auth/verify-email`.
Unverified users can log in and see the dashboard, but `POST /api/applications`
(drafts included) answers 403 `{ code: "EMAIL_NOT_VERIFIED" }`. They can ask
for another link with `POST /api/auth/resend-verification` (one a minute per
account, plus the per-IP limit `AUTH_RATE_LIMIT_MAX_RESEND_VERIFICATION`).

Who counts as verified:

- **Everyone created before this feature.** `User.emailVerified` defaults to
  `true`, so accounts with no stored flag are verified; there is no migration
  and nobody is locked out.
- **Google sign-ins** (Google verified the address). If the matching account
  was an unverified password sign-up, its password is removed, because whoever
  chose it never proved they own the inbox; the owner can sign in with Google
  or use "Forgot password".
- **Anyone who sets a password through an emailed link:** "Forgot password",
  or the first-password link sent to people who applied without an account.
  Those no-account applicants are created unverified and cannot log in until
  then.
- **Everyone, while email isn't configured** (no `SMTP_HOST` / `SMTP_USER`):
  nothing could be delivered, so sign-ups start verified and nothing is
  enforced. Check `utils/emailVerification.isEnforced()`.

### Waitlist mode and flagged applications

- **Waitlist mode** is per round: set `waitlistAfterAccepted` (a whole number
  of 1 or more; `null` or empty turns it off) on the round. Once that many of
  the round's applications are accepted, an application's *first submission*
  is saved as `waitlisted` and the applicant gets the `application_waitlisted`
  email instead of the "received" one. Applications already submitted are not
  moved, reviewers can still accept past the limit, and editing a submitted
  application keeps the status review gave it. The limit is never sent to
  applicants.
- **Flags** (`flagged`, `flagReasons`, `flaggedBy`) are staff-only; the
  application JSON applicants receive leaves them out. Moderators flag with a
  reason. With the admin setting `autoFlagApplications` on (off by default),
  an application's first submission is also flagged automatically for: a
  resume with almost no text, a resume that doesn't mention the applicant's
  name, the same phone number on another account, or the same resume file on
  another account. Resume text is read from Word files and from PDFs that
  store plain-string text; any other file is skipped, never flagged. See
  `utils/applicationFlags.js` (rules) and `utils/resumeText.js` (reading).

See [`../backend-tasks.md`](../backend-tasks.md) for the backlog.

## Workshops

All workshop routes return 404 when the workshops module is off. Attendee
routes require authentication and an accepted application; admin routes require
an admin. Capacity 0 means unlimited. Signups always use the caller's account.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/admin/workshops` | List all workshops, including drafts and cancellations |
| POST | `/api/admin/workshops` | Create a workshop |
| PATCH | `/api/admin/workshops/:id` | Edit; time or location changes email updated invites |
| DELETE | `/api/admin/workshops/:id` | Delete if empty, otherwise soft-cancel and email cancellations |
| GET | `/api/workshops` | Published, active workshops with spotsLeft (null = unlimited) and signedUp |
| GET | `/api/workshops/mine` | Caller's published, active workshops in time order |
| POST | `/api/workshops/:id/signup` | Reserve a seat; overlapping signups include a warning |
| DELETE | `/api/workshops/:id/signup` | Cancel caller's signup, free the seat and email a cancellation |

Managers are current moderators/admins or users assigned in `Workshop.organizers`.
Manager access does not require an accepted application. B17's organizer role and
assignment editor remain deferred. All routes below use the workshops feature gate.

| Method | Route | Access and purpose |
| --- | --- | --- |
| GET | `/api/workshops/manageable` | Authenticated: only workshops the caller can manage |
| GET | `/api/workshops/:id/me` | Accepted: workshop, attendanceOpen, attended, checkedIn, own wins and organizerRoom |
| POST | `/api/workshops/:id/attendance/open` | Manager: `{ minutes }`, default 10, whole number 1-180; 409 if already open |
| POST | `/api/workshops/:id/attendance/extend` | Manager: add `{ minutes }` (same validation) to an open session |
| POST | `/api/workshops/:id/attendance/close` | Manager: close and invalidate session secret |
| GET | `/api/workshops/:id/attendance/code` | Manager: `{ code, secondsLeft, openUntil }`, never cached |
| POST | `/api/workshops/:id/attendance` | Accepted + event checked-in: `{ code }`, own attendance only, idempotent 200 |
| POST | `/api/workshops/:id/attendance/staff` | Manager: `{ qrId }` or `{ userId }`; target must be accepted and event checked-in |
| GET | `/api/workshops/:id/attendance` | Manager: attendee names/emails, signedUp/attended/walkIns counts, workshop and organizerRoom |
| GET | `/api/workshops/:id/attendance.csv` | Manager: formula-safe attendance download |
| POST | `/api/workshops/:id/raffle/draw` | Manager: `{ count, prize, early? }`; 201 draw, 409 if disabled, before endsAt without early, or pool empty |
| POST | `/api/workshops/:id/raffle/:drawId/winners/:userId/claim` | Manager: record collection time |
| POST | `/api/workshops/:id/raffle/:drawId/winners/:userId/redraw` | Manager: mark unclaimed winner no-show, draw one replacement with redrawOf; 409 if exhausted |
| GET | `/api/workshops/:id/raffle` | Manager: draw history with winner names/emails |
| GET | `/api/admin/raffles` | Admin: draws across workshops |

Attendance codes have five unambiguous characters derived from HMAC-SHA256,
rotate every 30 seconds, and accept the current and previous period. Sessions
get a fresh secret on opening, excluded from all client responses. Attendance
never requires signup. A 10/minute user + IP limiter runs per server instance;
ten incorrect codes additionally lock the user out of that session in MongoDB,
including across server restarts. Staff can still add locked-out attendees.
Opening a new session resets the wrong-code budget; extending preserves it.

Raffles recheck acceptance and event check-in at draw time and exclude every
previous winner, including no-shows. Fisher-Yates uses `crypto.randomInt`.
A unique `(workshop, winners.user)` multikey index atomically stores the audit
and reserves winners, so concurrent draws retry against the new pool without
repeated winners. Ensure this index is built before serving raffle requests
(as with other schema uniqueness constraints). Draws store the actual winner
count, capped at pool size. A no-show remains recorded if no replacement is
available. Attendance and draw audit rows are retained when a workshop is cancelled.

`PATCH /api/admin/settings { organizerRoom }` accepts a string of at most 200
characters; blank uses "the organizer room". The Settings page edits it beside
the event settings. Background `raffle_winner` template emails and attendee
winner cards use that location. Lists also include attendanceOpen, attended,
only the caller's wins (`prize`, `claimed`), and organizerRoom.

Calendar emails use stable workshop UIDs and increasing sequences. Organizer
assignment, waitlists and subscription feeds are deferred.

## Judge accounts (B47)

Admin routes below require `requireFeature("judging")` and `isAdmin`:

| Method | Route | Body / response |
| --- | --- | --- |
| GET | `/api/admin/judges` | `{ judges }`: name, email, hardware, inviteStatus, calibrationDone |
| POST | `/api/admin/judges` | `{ name, email, hardware }`, creates or promotes and emails one invite |
| POST | `/api/admin/judges/preview` | `{ csv }`, returns `{ rows }` with row validation errors; no writes or emails |
| POST | `/api/admin/judges/bulk` | `{ csv, confirm: true }`, revalidates then sends; returns per-row results |
| POST | `/api/admin/judges/:id/resend` | Rotates token and sends a fresh seven-day invite |
| DELETE | `/api/admin/judges/:id` | Demotes to applicant, deactivates profile, invalidates invite |

`POST /api/auth/judge/accept { token, password }` is public and atomically consumes
the hashed invite token, returning `{ token, user }`. It works even while judging
is disabled. Invalid, expired and used tokens return 400. Passwords need at least
eight characters. `GET /api/auth/me` includes `user.judgeProfile` with `hardware`,
`calibrationDone` and `active` for judges, independent of the feature flag.

`GET /api/judging` is an `isJudge` placeholder (judges and admins). The guard
reads the current database role, so demotion revokes access immediately with the
same JWT. It is available independently of the feature flag. Future judging
features remain in B24. Judges cannot submit applications or obtain attendee QR
codes. Invite emails use the built-in `judge_invite` template and `{{inviteUrl}}`;
links are credentials, never persisted in the outbox or retried there.

## Judging rooms and projects

These routes require an admin and return 404 while `judging` is disabled.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/admin/judging/rooms` | List rooms in fill order |
| POST | `/api/admin/judging/rooms` | Create a room (name, order, capacity, hardware) |
| PATCH | `/api/admin/judging/rooms/:id` | Edit room configuration |
| DELETE | `/api/admin/judging/rooms/:id` | Delete a room; 409 if projects have tables in it |
| GET | `/api/admin/judging/projects` | List projects; filters: room id, hardware=true/false, category, unmatchedMembers=true/false |
| PATCH | `/api/admin/judging/projects/:id` | Override category, hardware, needsPower, withdrawn |
| POST | `/api/admin/judging/import` | Multipart `file`: UTF-8 CSV, max 2 MB / 2000 rows; create preview |
| POST | `/api/admin/judging/import/:id/confirm` | Apply the stored preview once, uploader only |

A preview contains `counts` (new, updated, unchanged, errors), valid `rows`,
row-numbered `errors`, unmatched names/emails and `unrecognizedColumns`.
It expires after 30 minutes. Confirmation ignores request body data and does
not rematch users or reparse a client-provided CSV. Valid rows are applied;
error rows are skipped. The preview is claimed atomically before applying it.
If an application fails partway through, upload again to preview remaining
changes; a consumed preview cannot be retried.

Both the cleaned export (including four identically named `TeamMem1*` triples)
and raw headers are read by position. Known raw aliases include Project Title /
Project Name, Submission Url / Submission Link / Project Url, Submitter First
Name / Last Name / Email, Opt-In Prizes / Opt In Prizes, Team Member N First
Name / Last Name / Email, Category / Judging Category, MLH Tracks, Hardware /
Hardware Judging and Needs Power. Matching is case-insensitive. Unknown columns
are reported instead of guessed. Raw prize selections populate `optInPrizes`;
without a recognized category column the judged category is empty and can be
set by an admin. Prize/track lists accept semicolon, comma or pipe separators.

Project URLs must use HTTPS, then follow team-link normalization (lowercase
slug, strip www, trailing slash, query and fragment). Dashboard Team membership
by URL is matched first, then remaining emails case-insensitively. Re-imports
upsert by URL and preserve room/table/check-in data and all marked overrides,
including overrides saved between preview and confirmation. No judging CSV
export is introduced here; any future project export must use `utils/csv`
(`formatCell` / `formatRow`), which neutralizes spreadsheet formulas. Imported
text remains plain text in JSON and React renders it as escaped text.

## Hardware lab

All hardware routes answer 404 while the hardware feature is off, before auth.
Attendee views require an accepted application. Checkout additionally requires
event check-in. Stock uses a conditional atomic decrement, with compensation if
creating a checkout fails. A unique partial index on open borrower/item/slot
loans enforces the attendee limit across concurrent requests. Returns claim the
open row once and restore one unit. Loan rows are never deleted.

Inventory CSV accepts `name,totalQty` and optional `category,description,link,
location,imageUrl,maxPerAttendee`. Import adds new items, never overwrites existing
stock. Preview validates every row before import. Limits: 500 KB and 1000 rows.
Changing an attendee limit requires all stock returned. Item archival preserves
references and requires all stock on hand. Receipts and reminders use the
`hardware_checkout`, `hardware_return` and `hardware_reminder` built-in templates,
sent in the background with event-zone times (`EVENT_TIMEZONE`).

Optional individual unit tracking and the reserve/request queue are deferred.
`trackUnits` remains false; item-level printable QR labels are supported.

Hardware loans save the borrower's checkout-time `team` reference and `teamName`
so history survives team deletion. Staff lists include `{ id, name }` snapshots,
`currentTeam`, and `teamChanged`; scanned attendees include their current team.
Checkout CSV includes the snapshot team name after email. Attendee routes still
return only inventory and the caller's own loans.

Admins can clear or set `OrgSettings.hardwareReturnBy` (Date, default null) in
Settings → General → Hardware. The datetime input uses `EVENT_TIMEZONE`, returned
with admin settings. The API accepts an ISO timestamp with an explicit offset
or `Z`, and null or an empty string to clear. A future deadline defaults new
loans' `dueAt` when staff provide none; existing loans keep their deadlines.

All three hardware receipt/reminder templates receive `{{returnBy}}`, formatted
in the event time zone, or “the last day of the event” when unset. They also receive
`{{name}}`, `{{itemName}}`, `{{eventTime}}`, and `{{dueTime}}`. Unedited legacy
checkout and reminder bodies upgrade on seed; customized bodies are preserved.
The new `hardware_team_change` template receives `{{name}}`, `{{items}}`,
`{{newTeam}}`, and `{{returnBy}}`. Creation, invite acceptance, leaving, and leader
removal trigger background notices to the affected borrower when hardware is on.
Only open loans with a different checkout-time team are included. An atomic
`teamChangeNotifiedAt` claim prevents repeated notices for the same loan; delivery
uses the existing email outbox and retry behavior.

## Judge calibration and rubric (B24d)

These routes require `requireFeature("judging")`. The B47 `/api/judging`
status endpoint retains its feature-independent behavior.

| Method | Route | Access | Body / response |
| --- | --- | --- | --- |
| GET | `/api/admin/judging/settings` | Admin | `{ settings }`, singleton defaults to three ordered practice projects and six criteria |
| PATCH | `/api/admin/judging/settings` | Admin | Partial `{ calibrationProjects, criteria, judgingOpen }`; returns `{ settings }` |
| GET | `/api/judging/calibration` | Judge or admin | `{ rounds, criteria, scores, calibrationDone }`, only caller's scores |
| POST | `/api/judging/calibration/:round` | Judge or admin with active profile | `{ scores: { criterionKey: integer }, comments }`; returns `{ scores, calibrationDone }` |
| GET | `/api/admin/judging/bias` | Admin | `{ judges: [{ id, name, done, bias }] }`, last stored values |
| POST | `/api/admin/judging/bias` | Admin | Computes and stores bias, same response as GET |

Rounds use one-based numbers. Earlier rounds must be scored first (409 otherwise).
Rescoring replaces that round and preserves later scores. All criteria are
required, integers within inclusive min/max; unknown keys and numeric strings
return 400. Comments are optional, at most 5000 characters. Completion means
every configured round has valid scores.

Calibration projects have `title`, optional `description` and optional HTTPS
`link`; array order defines round order (1–20 projects). Criteria have unique
alphanumeric/underscore `key` (starting with a letter), `label`, `help`, integer
`min`/`max` with min < max, positive finite `weight`, and `kind` of `general` or
`category`. There must be at least one general criterion and exactly one category
criterion, matching the existing pure bias function. Seeded ranges are Innovation
0–10, Functionality 0–10, Practicality 0–5, Presentation 0–10, Q&A 0–5 and Category
fit 0–10; weights default to 1. Bias reproduces the legacy unweighted means;
weights are reserved for project results.

Saving projects or criteria resets every profile's calibration and bias. After
`judgingOpen` first becomes true, both remain locked (409), including after
closing judging. `criteriaLocked` is internal and cannot be patched. Calibration
scores can still be edited; each score edit clears the whole cohort's stored
bias. Recompute bias after changes. Only active profiles belonging to current
judge users who finished all rounds contribute to the mean; incomplete,
inactive and removed profiles get null bias when computing. Stored bias has
`general`, `category` and `computedAt`. Missing profiles are shown as incomplete.
Future queues, real project scoring and results remain B24e–B24g.

## Judging desk and table check-in (B24c)

All routes below require `judging` enabled (404 otherwise).

| Method | Route | Access and body / result |
| --- | --- | --- |
| POST | `/api/staff/judging/desk-checkin` | Moderator/admin. `{ qrId }` or `{ userId }`, optional `projectId`. Accepted attendee required. Multiple projects return 409 with project choices. Returns project with table and room; repeated scans return the existing assignment. |
| GET | `/api/judging/projects` | Accepted participant, excludes judges. Only the caller's project names and table/check-in information. |
| POST | `/api/judging/table-checkin` | Accepted project member, excludes judges. `{ token }` from table sign. Desk check-in required, wrong table returns 409 naming the correct table and room. Idempotent. |
| GET | `/api/admin/judging/table-signs` | Admin. `{ signs: [{ tableNumber, room, qr }] }` with PNG data URLs for the printable HTML screen at `/dashboard/admin/judging/table-signs`. Random per-table tokens persist across printing and project undo. |
| POST | `/api/admin/judging/bulk-assign` | Admin. Without confirmation returns 409 and current `count`. Confirm with `{ confirm: true, count }` to assign remaining active projects and mark both steps complete. A stale count is refused. |
| POST | `/api/admin/judging/projects/:id/undo-table` | Admin. Clears room, table and both check-ins. Appends actor, timestamp and old table/room to `Project.tableUndoLog`. |

Tables use global continuous numbers in room order; hardware and regular projects
use their respective room pools. Allocation attempts a transaction; standalone
MongoDB transaction rejection falls back to atomic conditional writes and unique
indexes with retries. Full rooms return 409. Undo frees the number. Room layout
is locked after signs or assignments are created so numbering and printed signs
remain consistent. Configure all rooms before printing signs or opening the desk.

Desk check-in queues `judging_table_assigned` in the background for each matched
member account, with `{{name}}`, `{{table}}` and `{{room}}`. Repeat desk scans do
not queue the message again. Bulk fallback resumes unfinished projects after a
failure; earlier assignments are retained if a later room is full. This fallback
intentionally bypasses physical desk/table attendance. Withdrawn projects are
excluded. Future assignment generation must require both timestamps (B24e).

## Judging assignments and scoring (B24e, B24f)

All routes below require `judging` enabled (404 otherwise). Judge access uses
`isJudge` (current database role, judge/admin); admin routes use `isAdmin`.

| Method | Route | Body / result |
| --- | --- | --- |
| POST | `/api/admin/judging/assignments` | Admin. `{ judgingsPerProject: 3, slotMinutes: null }`. Both values optional. Positive integer judgings (1–100), optional positive timer minutes (up to 240). Returns 201 with inactive `assignment` and `verifierReport`, or 422 with reports and no version saved. |
| GET | `/api/admin/judging/assignments` | Admin. `{ versions, activeVersion, judgingOpen }`, newest first, including original verifier reports and queues. |
| POST | `/api/admin/judging/assignments/:version/activate` | Admin. Explicitly select the active version; 404 for unknown version. Prunes withdrawn projects and inactive/demoted judges. |
| POST | `/api/admin/judging/assignments/judges` | Admin. `{ judgeId, projectIds }`. Add an active judge with distinct eligible projects in order. Hardware projects require a hardware profile. Existing queue returns 409; remove it before replacing. |
| DELETE | `/api/admin/judging/assignments/judges/:judgeId` | Admin. Remove judge from active queues, preserve scores and profile. Role demotion and judge removal also prune the queue. |
| POST | `/api/admin/judging/projects/:id/withdraw` | Admin. Mark withdrawn and remove from every active queue, skips and slots. Existing project PATCH withdrawal does the same. Scores remain. |
| POST | `/api/admin/judging/close` | Admin. Freeze score writes and skips (409). |
| POST | `/api/admin/judging/open` | Admin. Allow score writes and skips. |
| GET | `/api/judging/queue` | Judge. Safe project details, current project, positions, slot numbers, full assignments, skipped/done lists, own scores/comments, rubric, timer duration and closed state. |
| POST | `/api/judging/scores` | Judge. `{ projectId, scores: { criterionKey: integer }, comments? }`. Complete rubric required, comments up to 10000 chars. Upserts on judge/project; scoring current advances, scoring skipped unskips, rescoring done does not advance. Upcoming projects must wait (409). |
| POST | `/api/judging/skip` | Judge. `{ projectId? }`. Skip only the current project (409 for another assigned project). Omitted id means current. Clients should send id to reject stale actions. |

Scoring/skipping return 404 for unknown projects, 403 for projects outside the
caller's active queue, and 409 while closed. Scores are independent of versions:
scored projects in a new queue are already done; scores outside it are retained
for future results. The default rubric is isolated in
`utils/judging/criteria.js#getCriteria()` for the parallel B24d settings adapter.
No calibration gating is introduced until that branch meets this one.

Generation requires both project check-in timestamps, excludes withdrawn
projects, and uses separate regular and hardware judge/profile pools. Hardware
judges do not participate in the regular generation. Configured room capacities
control starting proportions; explicit occupied table lists preserve vacancies
and real room membership. All pool verifiers must pass before saving anything.
The timer is advisory, starts when a judge opens a project, persists in that tab,
and never prevents saving after it expires.

Late additions append slots after all existing queues to avoid slot collisions.
Late additions/removals and withdrawals may alter per-project coverage and load;
the saved verifier report describes the **original generation**, not a fresh
verification of those edits. Review active queues or generate a new version to
restore full verified coverage. Withdrawal retains null slot gaps.

Assignment changes, score writes and open/close share a database singleton lock,
so requests across server processes cannot race freeze or activation. Busy
requests retry briefly, then return 409. If a process dies during a locked write,
confirm it has stopped and inspect the affected data before clearing
`JudgingState` document `_id: "judging"` field `busy` to false. Locks intentionally
do not expire into overlapping writes. Multi-document writes are retryable but
not transactions: a failed response can have persisted a score or withdrawal;
queue reads derive done state from scores and exclude withdrawn projects.

## Judging progress, results and exports (B24g)

Every route below requires the `judging` feature flag. JSON and downloads use
`Cache-Control: no-store`.

| Method | Route | Access and response |
| --- | --- | --- |
| GET | `/api/admin/judging/progress` | Moderator/admin. `{ activeVersion, judgingOpen, judgingsPerProject, projects, judges, missingProjects }`. Projects expose name, category, table, scoresIn, assigned and missingScores; judges expose name, email, done and total. |
| GET | `/api/admin/judging/results` | Admin. `{ results, judgingOpen }`. Each project includes scoreCount, rawGeneral, adjustedGeneral, rawCategory, adjustedCategory, overallRank, categoryRank, flags and uncalibratedJudges. |
| GET | `/api/admin/judging/scores.csv` | Admin. Judge name/email, project/table, every live criterion, comments and last saved time (ISO). All retained scores, including outside active queues. |
| GET | `/api/admin/judging/results.csv` | Admin. Project totals, counts, both ranks, withdrawal and warning flags. |
| GET | `/api/admin/judging/progress.csv` | Moderator/admin. Per-judge done/total and active version. |

Progress counts distinct judge/project pairs in the active version, ignoring
withdrawn/deleted projects. Scores from other versions only count when the pair
also appears in the active queue. Missing coverage means scores in is below the
larger of assigned count and configured judgingsPerProject (default 3 without an
active version), so underassigned projects remain visible. No active version
returns empty judge progress and zero assigned counts.

Results use all retained scores. For each judge/project, general total is
`sum(criterion.weight * score)` over general criteria; category total uses category
criteria. Raw totals average those judge totals. Adjusted totals subtract the
judge's stored general/category bias once before averaging. Bias retains the
calibration module's units, with no rescaling, normalization or clamping. Missing
or incomplete bias contributes zero and raises `flags.noCalibration`; fewer than
the configured target raises `flags.missingScores`. Empty projects have null totals
and ranks. Overall ranks use adjusted general totals; per-category ranks use
adjusted category totals. Exact ties share competition rank (1, 1, 3). Withdrawn
projects retain audit totals but receive no rank. The UI also supports raw ranks.

Downloads use the shared CSV writer, UTF-8 BOM, RFC quoting and formula escaping.
Staff progress refreshes every 15 seconds at `/dashboard/staff/judging/progress`;
admins also have Progress and Results tabs in the judging console. Results are
staff-only working data; this does not publish winners or prizes (B24h).

## Judging teams and participant sheet

`Project.team` is a sparse unique Team reference. Import previews match by
Devpost URL first, then the first matching member email in CSV order. Existing
links survive re-import. Every row reports `matchedTeam` (or null) and warnings
listing teams when emails span multiple teams. All submissions colliding on a
team are errors and skipped; existing submissions at another URL also conflict.
Matched team members and other matched users are combined. Confirmation refreshes
team membership, preserving the preview's matched-user accounts and current
admin overrides. Project PATCH accepts `team: "<id>"` or null/empty to clear;
invalid or already-linked teams are rejected.

Desk and bulk check-in lock the linked team before allocation. Self-service
membership, invitations, name and Devpost changes return 423 with the help-desk
message while locked. Team reads still work. Admin table undo unlocks the team.
On standalone MongoDB an allocation failure can leave the team locked; staff can
retry allocation or an admin can explicitly unlock it. Membership changes,
allocation, undo, staff changes and import row writes share the existing judging
lease. As elsewhere in judging, multi-document standalone writes are not a
transaction; inspect and retry partial failures.

All routes below require the judging feature. Staff access uses current-role
`isModerator`; unlock uses `isAdmin`; sheet uses authentication plus a database
role/acceptance check. No response includes attendee QR credentials.

| Method | Route | Request / response |
| --- | --- | --- |
| POST | `/api/staff/teams/lookup` | Staff. `{ qrId }`, `{ userId }` or `{ email }`. Safe attendee summary and team with members, pending invites, lock, project and table/room. Attendee help can look up unaccepted accounts. |
| POST | `/api/staff/teams/:id/invites` | Staff. `{ email }`. Same team invite template, staff inviter, pending invites count toward max size. Works while locked. |
| DELETE | `/api/staff/teams/:id/invites/:email` | Staff. Cancel a pending invite, including while locked. |
| POST | `/api/staff/teams/:id/members` | Staff. `{ qrId }` or `{ userId }`. Accepted participant on no team; respects capacity including remaining invites. Consumes that attendee's invite. |
| DELETE | `/api/staff/teams/:id/members/:userId` | Staff. Remove a member while locked. Transfer leadership to the first remaining member; retain an empty team for its audit/project, and give the next direct addition leadership. |
| POST | `/api/admin/teams/:id/unlock` | Admin. Explicit unlock, logged on the team. |
| GET | `/api/judging/sheet` | Accepted participants and staff; judges get 403. Closed: `{ open: false }`. Open: `{ open: true, software, hardware, ownTeam }`. |

Staff actions append `staffChanges` (actor, time, action, user/email), synchronize
the linked project's members with the team, and notify the hardware team-change
helper for membership changes. Invite email is queued in the background.

The participant sheet lists rooms in configured order within separate software
and hardware arrays. Each room has `name`, `judgeCount` and `judges` with only
`label` and current `table`. Current means the first unscored, unskipped,
non-withdrawn project, matching the judge queue. Completed judges are absent.
Anonymous ordinal labels are stored per version and survive room moves and
queue removals. Labels use no names, emails or identity-derived values.
`ownTeam` contains only `table`, `room`, `done` and `assigned`, or null. Responses
are not cached; `/dashboard/judging-sheet` polls every 30 seconds.
