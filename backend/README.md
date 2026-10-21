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
                   signToken, passport (Google), mailer, azureBlob, googleStatus,
                   requireFeature + features (module flags), branding,
                   orgSettingsCache, imageType, orgLinks
controllers/       auth, application, admin, settings, meta, branding logic
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
| POST   | `/api/applications`            | user      | Create/update application (multipart)  |
| GET    | `/api/applications/me`          | user      | Open round + your application          |
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
| PATCH  | `/api/admin/settings`           | admin     | Update settings (Google toggle, `features`, `branding`) |
| PUT    | `/api/admin/branding/:slot`     | admin     | Upload `logo` / `logo-dark` / `favicon` (multipart `file`) |
| DELETE | `/api/admin/branding/:slot`     | admin     | Remove that image (back to the server default) |

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
> `meals` is mounted on `/api/admin/meals` and `/api/staff/meals`. The other
> four flags default on and gate nothing yet; when their modules land, mount
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

See [`../backend-tasks.md`](../backend-tasks.md) for the backlog.
