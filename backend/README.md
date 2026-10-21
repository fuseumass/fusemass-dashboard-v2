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
rejected (with their check-in QR code), when they check in, and for password
resets. Until email is set up those emails are skipped, and password-reset
links are only printed in the server log.

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
| `EMAIL_RETRY_INTERVAL_MS` | `30000` | How often the retry worker looks for due emails |
| `EMAIL_LOG_RETENTION_DAYS`| `90`    | How long outbox rows are kept                 |

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
                   signToken, passport (Google), mailer, outbox (email log +
                   retries), emailSegments, unsubscribe, azureBlob, googleStatus
controllers/       auth, application, admin, settings, meta logic
routes/            express.Router() tables (auth, applications, admin, meta)
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
| GET    | `/api/health`                   | public    | Liveness check                         |
| GET    | `/api/health/db`                | public    | Database check: 200 up / 503 down      |
| POST   | `/api/auth/register`            | public    | Create applicant, return JWT           |
| POST   | `/api/auth/login`               | public    | Log in, return JWT                     |
| POST   | `/api/auth/forgot-password`     | public    | Email a reset link                     |
| POST   | `/api/auth/reset-password`      | public    | Consume token, set new password        |
| GET    | `/api/auth/google`              | public    | Start Google OAuth (if enabled)        |
| GET    | `/api/auth/google/callback`     | public    | OAuth callback → redirect with token   |
| POST   | `/api/auth/setup-admin`         | env-gated | Bootstrap first admin (`SETUP_ADMIN`)  |
| GET    | `/api/auth/me`                  | user      | Current user                           |
| POST   | `/api/auth/unsubscribe`         | public    | Turn announcement emails off (link token) |
| PATCH  | `/api/auth/me`                  | user      | Set `marketingEmailConsent`            |
| POST   | `/api/applications`            | user      | Create/update application (multipart)  |
| GET    | `/api/applications/me`          | user      | Open round + your application          |
| GET    | `/api/applications/public/round` | public*  | Open round + form, for applying without an account |
| POST   | `/api/applications/public`      | public*   | Apply without an account (multipart, `email` + fields) |
| GET    | `/api/applications/me/resume`   | user      | 5-min signed link to your resume       |
| GET    | `/api/meta/config`              | public    | Org name + Google-enabled flag         |
| GET    | `/api/meta/colleges?q=`         | public    | University autocomplete                |
| GET    | `/api/meta/skills/programming?q=` | public  | Programming-skill autocomplete         |
| GET    | `/api/meta/skills/hardware?q=`  | public    | Hardware-skill autocomplete            |
| GET    | `/api/admin/applications`       | moderator | List applications (`?status=&round=`)  |
| PATCH  | `/api/admin/applications/:id`   | moderator | Decide (`{ decision }`)                |
| GET    | `/api/admin/applications/:id/resume` | moderator | 5-min signed link to its resume   |
| GET    | `/api/admin/users?q=`           | admin     | Search users                           |
| PATCH  | `/api/admin/users/:id/role`     | admin     | Set role (`applicant/moderator/admin`) |
| GET    | `/api/admin/rounds`             | admin     | List rounds                            |
| POST   | `/api/admin/rounds`             | admin     | Create round                           |
| PATCH  | `/api/admin/rounds/:id`         | admin     | Update round (dates, open, formConfig) |
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
| PATCH  | `/api/admin/settings`           | admin     | Update settings (Google toggle)        |

See [`../backend-tasks.md`](../backend-tasks.md) for the backlog.
