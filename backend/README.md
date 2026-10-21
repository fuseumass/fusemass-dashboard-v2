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
  days.
- **Replies** go to the sending account, so check it or say "do not reply" in
  your email templates (admin dashboard → email templates).
- **Google Workspace accounts can't use app passwords for this** (Google
  removed password sign-in for apps in 2025). Use a personal Gmail account,
  or another provider's SMTP server: set `SMTP_HOST` / `SMTP_PORT` when you
  run the script.

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
schemas/           User, Application, ApplicationRound, OrgSettings, Team
utils/             parseToken (global), isAuthenticated/isModerator/isAdmin,
                   isEmailVerified, signToken, passport (Google), mailer,
                   emailVerification, azureBlob, googleStatus
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
| POST   | `/api/applications`            | user, verified email | Create/update application (multipart); 403 `EMAIL_NOT_VERIFIED` until verified |
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
| GET    | `/api/admin/settings`           | admin     | Org settings (+ Google env status)     |
| PATCH  | `/api/admin/settings`           | admin     | Update settings (Google toggle)        |

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

See [`../backend-tasks.md`](../backend-tasks.md) for the backlog.
