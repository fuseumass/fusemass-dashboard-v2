# Backend Tasks

Backlog for the Express 4 + Mongoose API. Task IDs are `B#`. Cross-file links:
`F#` = a frontend task, `T#` = a testing task. See also
[`frontend-tasks.md`](./frontend-tasks.md) and [`testing-tasks.md`](./testing-tasks.md).

> **Workflow:** branch + pull request only — never commit to `main`. See the
> rule in [`README.md`](./README.md).

Already built (so they are not tasks here): email/password auth + JWT, Google
OAuth, password reset (nodemailer), the `applicant`/`moderator`/`admin` roles +
`isAuthenticated` / `isModerator` / `isAdmin` guards, the standard application +
resume→Azure upload, application rounds (create/open/close/dates/formConfig), org
settings + Google toggle, first-admin bootstrap (`SETUP_ADMIN`), user search +
promote, the colleges/skills autocomplete endpoints, editable email templates
(`/api/admin/email-templates`) with received/decision emails, first check-in
(`/api/staff/checkin`), meal service admin CRUD (`/api/admin/meals`), per-round
`formConfig` validation + dynamic `answers`, the `validateBody` request-validation
middleware, and auth-endpoint rate limiting.

**In review on `feature/qr-checkin`** (don't start these again): per-attendee
check-in QR codes (SHA-256 of the email, `User.qrId`) emailed on acceptance and
shown on the dashboard; QR/search event check-in with a `User.checkedIn` flag;
the `checked_in` email (Discord + website links from `ORG_WEBSITE_URL` /
`ORG_DISCORD_URL`, run of show as a calendar invite); the run of show
(`ScheduleEvent`, `/api/admin/schedule`); meal check-in (**B7**); and
`utils/calendar.js` (`.ics` builder), which the workshop tasks below reuse.

### Where these tasks come from

Most of the new tasks port features from the platforms we used before, fixing
their bugs on the way. Each task has a **Don't repeat** list of the bugs found
in the old code. **[`feature-parity.md`](./feature-parity.md) lists every old
feature, its status here, and its task;** update it when you land or drop
something.

- **Old dashboard** ([fuseumass/dashboard](https://github.com/fuseumass/dashboard),
  Rails, last commit 2023). It had registration, QR check-in, hardware
  inventory + checkout, workshop/event RSVPs, mentorship tickets, projects +
  prizes + judging, mass emails, feature flags, CSV exports and Slack. **Keep
  the ideas:** one QR per attendee used everywhere, per-item checkout logs,
  per-feature on/off flags, YAML-style configurable questions (we already have
  `formConfig`). **Drop:** Slack (we use Discord + email), and its permission
  model, which was mostly missing (see the tasks below).
- **Judging platform** ([gamer-1478/HackUMass-Judging-New](https://github.com/gamer-1478/HackUMass-Judging-New),
  Express 5 + EJS, used Nov 2025). **Keep the ideas:** practice ("tutorial")
  rounds to measure each judge's bias, transactional table assignment with
  retries and a unique (room, table) index, an assignment generator with a
  separate verifier, separate hardware-judging tables. **Drop:** CSV-file
  logins, the missing admin role, `GET` routes that change data, and the
  unused `openai`/`ai`/SendGrid dependencies.

---

## 🚨 Urgent (do first, outside this repo)

### B16. Judging repo leaks judge passwords and participant data
The public repo `gamer-1478/HackUMass-Judging-New` has committed
`datafiles/judges_auth.csv` (9 judges' emails with **plaintext passwords**,
used as the login database) and `datafiles/teams-final.csv` (~163 teams'
participant names and emails), both since Nov 2025.
- [ ] Make the repo private now (it's public, and it may already be indexed or
      forked).
- [ ] Tell the judges; anyone who reused that password elsewhere should change
      it.
- [ ] Remove both files and purge them from history (`git filter-repo`), then
      force-push. Making it private alone isn't enough: anyone who has cloned
      it still has them.
- [ ] Decide whether the participant-data exposure needs reporting under the
      university's data policy.
- [ ] Also check the old dashboard's config submodule
      (`ammuiyer/HackUMass-XI-Config`): it held the "redeem codes" that turned
      anyone into an organizer or admin (see B17), plus email settings. Make
      sure it's private and the codes are dead.
- [ ] Add secret scanning to our CI (see **T15**) so this can't happen here.
- **Depends on:** none. **Owner:** whoever has admin on those repos.

---

## Check-in (event day)

### B7. Meal check-in endpoint - Richarla Preston @charlajp
Record a check-in per user per meal service (one row each, prevents double
serving). `POST /api/staff/meals/:mealId/checkin`, guarded by `isModerator`.
- **Status:** done in review on `feature/qr-checkin` (QR or userId, 409 on
  repeats, simultaneous scans tested).
- **Depends on:** B6 (done). **Related:** F3, T3.

### B27. Accepted applicants lose their status once applications close
`GET /api/applications/me` only returns the application for the *currently
open* round. On event day applications are closed, so an accepted attendee's
home page says "Applications aren't open right now". This is exactly when
they need it.
- [x] Return the applicant's most recent application across all rounds when no
      round is open (or add `GET /api/applications/me/latest`).
- [x] Include `checkedIn` and the round name so the home page can show "You're
      in — see you at check-in" vs. "You're checked in".
- **Status:** done. `GET /api/applications/me` keeps `round` / `application`
  (the open round) and adds `latest: { application, round: { _id, name },
  checkedIn, checkedInAt }` (null if they never submitted). `latest` picks an
  accepted application over a newer rejected/pending one, skips drafts, and is
  also sent while a round is open (so an attendee accepted in an earlier round
  can be told so). Tests: `test/latestApplication.test.js`.
- **Depends on:** none. **Related:** F22.

### B26. Email outbox: log, retry and resend
Every email today is fire-and-forget: if SMTP blips during a batch of
acceptances, those emails (and their QR codes) are lost silently. The judging
platform had to bolt on a `/check-failed-emails` page for the same reason.
- [x] `EmailLog` schema: `to`, `templateKey`, `user`, `status`
      (`queued|sent|failed`), `attempts`, `lastError`, `sentAt`.
      (`schemas/emailLog.js`. Also `cancelled` status, `category`,
      `nextAttemptAt`, a lease (`lockedUntil`), the template `values` so a
      retry renders the same email, and a TTL index (`expiresAt`, 90 days,
      `EMAIL_LOG_RETENTION_DAYS`). Attachments are never stored: the QR is
      redrawn from the address. Emails carrying a single-use link
      (password reset, account setup) are `redacted`: no values, no body.)
- [x] `utils/mailer` writes a log row per send; retry failed sends with
      backoff (an in-process interval is fine at our scale; no new
      infrastructure).
      (`utils/outbox.js`. The caller still sees the first attempt's result.
      Backoff 1 min, 5 min, 30 min, 2 h, 6 h, then `failed` after 6 attempts;
      permanent SMTP errors fail at once. Atomic claim + lease = no double
      sends; a send interrupted by a restart is marked failed "may have been
      delivered", never auto-resent. The worker pauses after 3 transient
      failures in a row. Callers that await and report failures to staff pass
      `retry: false`.)
- [x] Admin: list failures, resend one, and **resend acceptance emails**
      (needed for anyone accepted before QR codes shipped).
      (`/api/admin/outbox`: list/filter, `:id/resend`, `:id/cancel`,
      `retry-failed`, `cancel-queued`, `resend-acceptance`. Page:
      `/dashboard/admin/outbox`, not yet linked from the sidebar.)
- [ ] Bulk email to a segment (not applied / pending / accepted / waitlisted /
      rejected / checked in / workshop sign-ups / people still holding
      hardware / "test to myself"). This replaces the old dashboard's
      mailing lists and Slack blasts.
      (`POST /api/admin/outbox/bulk` with a stored template; segments in
      `utils/emailSegments.js`, plus "started but didn't submit". **Not yet:**
      workshop sign-ups (waits for B18) and people still holding hardware
      (waits for hardware checkout, B22). Both are listed as unavailable, and
      turn on by filling in one resolver each. The compose UI is a frontend
      follow-up.)
- [x] **Consent:** add `User.marketingEmailConsent` (asked at sign-up,
      editable in profile, off by default) and an unsubscribe link. Bulk
      *announcement* emails go only to people who consented; transactional
      ones (decisions, QR, check-in, workshop invites, hardware receipts) always
      send. The old dashboard enforced this (`non_transactional_email_consent`)
      and had a branch for the SendGrid opt-in/opt-out rules; we don't yet.
      (Backend done: `register` and the public application take
      `marketingEmailConsent`, `PATCH /api/auth/me` edits it, announcements
      carry an unsubscribe link (`/unsubscribe` page, `POST
      /api/auth/unsubscribe`) and consent is re-checked at send time. **The
      sign-up checkbox and profile toggle are frontend follow-ups.**)
- **Depends on:** none. **Related:** B21 (raffle winners), B22 (hardware
  reminders), B24c (table emails).

---

## Roles & permissions

### B17. `workshop_organizer` role, scoped to assigned workshops
New role for workshop hosts: they can see and manage **only the workshops an
admin assigned them to**, and nothing else (no applications, users, settings
or check-in).
- [ ] Add `workshop_organizer` to the `User.role` enum and to
      `PATCH /api/admin/users/:id/role` validation.
- [ ] `Workshop.organizers: [User]` holds the assignment (B18). Admins assign
      or unassign through `PUT /api/admin/workshops/:id/organizers`.
- [ ] Guard `utils/canManageWorkshop(req, res, next)`: let through admins, and
      `workshop_organizer`s listed in that workshop's `organizers`. Read the
      workshop id from `req.params`, never from the body; 403 otherwise.
      Unknown workshop → 404.
- [ ] Every organizer endpoint uses this guard, and list endpoints filter to
      the caller's workshops on the server (don't rely on the UI hiding
      them).
- [ ] **Decided: moderators and admins can run workshops too.** The guard
      checks the **assignment**, not the role: anyone in `organizers` who is a
      `workshop_organizer`, `moderator` or `admin` can manage that workshop
      (admins can manage every workshop regardless). The `workshop_organizer`
      role is for hosts who aren't otherwise staff. Assigning an applicant
      offers to make them a `workshop_organizer` first; judges can't be
      assigned.
- [ ] Judges get their own role: see B47.
- **Don't repeat:** the old dashboard's `redeem_code` let any attendee who
  hadn't RSVP'd or checked in become an organizer or **admin** by typing a
  code from a config file. Roles change only through admin endpoints.
- **Depends on:** none. **Related:** B18–B21, F18, F19, T12.

### B47. `judge` role
Judges become dashboard users. No CSV logins, no passwords handled by
organizers. Judges are usually external (faculty, sponsors, alumni), so they
see **only** judging: no application form, QR card, workshops, meals or
staff screens.

**Steps (one PR; coordinate with B17, which also edits the role enum):**
1. [x] **Schema:** add `"judge"` to the `role` enum in `backend/schemas/user.js`
   and update the roles comment at the top of that file.
2. [x] **Role validation:** add `"judge"` to the `validateBody` enum on
   `PATCH /users/:id/role` in `backend/routes/admin.js`.
3. [x] **Guard:** new `backend/utils/isJudge.js`, in the same shape as
   `isModerator.js`: 401 without a user, 403 unless `role` is `judge` or
   `admin` (admins can test the flow). JSDoc like the other guards.
4. [x] **Keep judges out of everything else:** check that `isModerator`/`isAdmin`
   reject `judge` (they test exact roles, so they should). Also make
   `POST /api/applications` and `/api/applications/me/qr` return 403 for
   judges, so a judge account can't apply or get an attendee QR.
5. [x] **Invite flow** (`POST /api/admin/judges { name, email, hardware }`,
   isAdmin): create the user with `role: "judge"` (or promote an existing
   account), create their `JudgeProfile` (B24d), and email an invite whose link
   sets their password. Reuse the password-reset token code in
   `authController` (hashed token, expiry), with a longer expiry (e.g. 7
   days) and an "invite" email template. Re-sending an invite rotates the
   token. Google sign-in also works if their Google email matches.
6. [x] **Bulk invite:** CSV upload of name, email, hardware → the same flow per
   row, with a preview. This replaces `judges_auth.csv`.
7. [x] **List/remove:** `GET /api/admin/judges` with calibration and invite
   status; removing a judge demotes them to `applicant` and deactivates their
   profile. Progress awaits B24g; active assignment removal awaits B24e.
8. [x] **`/api/auth/me`:** include the judge's profile summary (hardware flag,
   calibration done) so the frontend can route them.
9. [x] **Docs:** update the roles line in `AGENTS.md` and the README role table.
10. [x] **Tests (T12, T11):** every guard with a judge token; judges get 403 on
    `/api/admin/*`, `/api/staff/*`, applications and the QR endpoint; the
    invite token can be used once and expires; a demoted judge loses access
    immediately (JWT role is re-checked against the database for judging
    routes, or tokens are short-lived; decide which in the PR).

Implemented B47. Assignment removal is implemented in B24e;
progress awaits B24g. Minimal JudgeProfile is ready for B24d.
- **Depends on:** none. **Related:** B24a–B24i, F27, T11, T12.

### B25. Feature flags per module
Let each hackathon switch modules on or off at runtime: meals, hardware,
workshops, judging, raffles. The old dashboard had this; we should too.
- [x] `OrgSettings.features: { meals, hardware, workshops, judging, raffle }`
      (booleans, default on), editable via `PATCH /api/admin/settings`.
      Partial updates; values must be real booleans (`"false"` is a 400, not
      coerced to true); unknown keys are a 400.
- [x] `utils/requireFeature("hardware")` middleware: answers **404** for
      everyone when the feature is off (admins too, so a disabled module
      can't be half-used). Mount it on each module's router. **Mounted today
      on `meals`** (`/api/admin/meals`, `/api/staff/meals`); the other four
      flags default on and gate nothing until their modules exist.
      **Rule for B17-B24: every router of a flag-gated module must mount
      `requireFeature("<key>")` before its auth guards, with a test that it
      404s for admin, moderator and anonymous callers while off** (see
      `backend/README.md`, "Feature flags").
- [x] Expose the flags to the frontend (public part of
      `GET /api/meta/branding`, see B28) so the nav hides disabled modules.
      (Sidebar hides the meals items; the full nav config is F13.)
- **Don't repeat:** the old `check_feature_flag?` called `.value` before its
  nil check (crashed when a flag was missing). Its bypass,
  `(not admin or not organizer)`, was true for everyone who wasn't both, so
  admins were locked out too.
- **Depends on:** none. **Related:** F13.

---

## Workshops

### B18. Workshop model + admin CRUD
- [x] `schemas/workshop.js`: `title`, `description`, `host` (speaker name),
      `location`, `startsAt`, `endsAt`, `capacity` (0 = unlimited),
      `signupCount` (kept in step with B19), `organizers: [User]`,
      `published` (hidden from attendees until true), `raffleEnabled`.
- [x] Admin CRUD at `/api/admin/workshops` (`isAdmin`), the same pattern as
      `/api/admin/meals` and `/api/admin/schedule`.
- [x] Attendee list: `GET /api/workshops` (published only, accepted
      applicants), each with `spotsLeft` and whether the caller is signed up.
- [x] Changing `startsAt`/`endsAt` of a workshop with sign-ups triggers updated
      calendar invites (B19).
- [x] Deleting a workshop with sign-ups: soft-cancel instead (`cancelled:
      true`), email the sign-ups and send calendar cancellations. Same reasoning
      as meals, which can't be deleted once served.
- **Depends on:** B17. **Related:** F17, F19.

### B19. Workshop sign-up, my workshops, calendar invites
Attendees pick and manage the workshops they're signed up for, and each one
lands in their calendar.
- [x] `schemas/workshopSignup.js`: `user`, `workshop`, `createdAt`; unique
      index on (user, workshop).
- [x] `POST /api/workshops/:id/signup` / `DELETE` (cancel). Only accepted
      applicants. Ignore any user id in the body; always act on `req.user`.
- [x] **Capacity must hold under concurrency:** take a seat with
      `Workshop.findOneAndUpdate({ _id, $or: [{ capacity: 0 }, { $expr: { $lt: ["$signupCount", "$capacity"] } }] }, { $inc: { signupCount: 1 } })`,
      then create the sign-up. Roll the counter back if the unique index says
      they were already signed up. Cancelling decrements.
- [ ] Optional waitlist: when full, join a waitlist; on cancellation promote
      the first waiter and email them.
- [x] Warn (don't block) when a sign-up overlaps another of the user's
      workshops.
- [x] `GET /api/workshops/mine`: the caller's workshops, ordered by time.
- [x] **Calendar invite per sign-up**, using `utils/calendar.js` from
      `feature/qr-checkin`. Give each event a stable `UID`
      (`workshop-<id>@<website host>`) and a `SEQUENCE` that goes up on every
      change, so calendars update the existing entry instead of adding a
      duplicate:
  - on sign-up: email with the invite (`METHOD:PUBLISH`, or `REQUEST` if we
    want RSVP buttons);
  - on time/location change: re-send to everyone signed up with
    `SEQUENCE + 1`;
  - on cancel (theirs or ours): `METHOD:CANCEL` with the same UID, which
    removes it from Google Calendar.
- [ ] Nice-to-have: per-user subscribe feed `GET /api/calendar/:token.ics`
      (random token stored on the user, not the JWT), with all their workshops
      plus the run of show, so updates flow without emails.
- **Don't repeat:** the old dashboard's RSVP took `user_id` from the URL (anyone
  could sign anyone up or out), never enforced `max_seats`, and allowed
  duplicate RSVPs (no unique index). Its un-RSVP crashed when there was no
  RSVP (`find_by(...).destroy` on nil).
- **Depends on:** B18. **Related:** F17, T9.


Implementation scope: B17 organizer assignment and views, optional waitlist and
per-user calendar subscription feed are deferred. The organizers field is reserved.

### B20. Workshop announcements feed (files + posts)
A chat-style announcement channel per workshop. Organizers post slides,
starter code and links; **every accepted attendee** can read them, signed up
or not. It's one-way: organizers post, attendees don't reply.
- [ ] `schemas/workshopPost.js`: `workshop`, `author`, `body` (plain text,
      URLs linkified on render, no raw HTML), `attachments: [{ name, blobName,
      size, contentType }]`, `pinned`, timestamps.
- [ ] `POST /api/workshops/:id/posts` (multipart, `canManageWorkshop`): up to 5
      files per post; size limit (e.g. 25 MB) and allowed types (pdf, pptx/key,
      docx, zip, images, ipynb, txt/md). Reuse `utils/azureBlob` with a
      **private** container.
- [ ] `GET /api/workshops/:id/posts` (newest first, cursor paginated) for
      **all accepted attendees** (decided: signing up isn't required to see
      materials), organizers and admins. Unpublished or cancelled workshops
      stay hidden from attendees.
- [ ] `GET /api/workshops/:id/files/:postId/:index`: check access, then
      redirect to a short-lived (≈5 min) SAS URL. Never store or return
      permanent public blob URLs.
- [ ] `PATCH` (edit / pin) and `DELETE` (author or admin; deletes the blobs).
- [ ] Optional: email signed-up attendees when a post is made (digest, not one
      email per post; via B26).
- [ ] Live updates: polling every ~15 s is enough to start; SSE later if
      needed. No websockets.
- **Depends on:** B17, B18. **Related:** F18, T9.

### B21. Workshop attendance (Top Hat-style) + raffle
Raffles happen **after** a Top Hat-style attendance check-in at each workshop:
1. During the workshop the organizer opens attendance, and a short code shows
   on the projector.
2. Attendees in the room type it on their dashboard, which records
   attendance.
3. At the end the organizer draws raffle winners **from the attendees**. No
   separate raffle code.

**Attendance**
- [x] `schemas/workshopAttendance.js`: `user`, `workshop`, `checkedInAt`,
      `method` (`code` | `staff`), `addedBy?`; unique index on
      (user, workshop).
- [x] Attendance session: `POST /api/workshops/:id/attendance/open`
      (`canManageWorkshop`) with a duration (default 10 min); `extend` and
      `close` endpoints. One open session per workshop at a time.
- [x] **Rotating code**, like Top Hat: 4–6 characters from an unambiguous
      alphabet (no 0/O/1/I), changing every 30–60 s so a code texted to
      friends outside goes stale. Derive it as
      `HMAC(sessionSecret, floor(now / period))` so nothing is stored per
      rotation. Accept the **current and previous** code to allow for typing
      lag.
- [x] `GET /api/workshops/:id/attendance/code` (organizer): current code +
      seconds until it rotates, for Present mode (F18). Optionally also return
      a URL with the code embedded, for a QR attendees can scan.
- [x] Attendee: `POST /api/workshops/:id/attendance { code }`. Only accepted
      applicants who are **checked in to the event** (`User.checkedIn`), with
      an open session and a valid code. Not checked in → 403 "Check in at the
      front desk first". A workshop sign-up is **not** required, so walk-ins
      count. Idempotent (a repeat is a 200 "already here", not an error).
      Ignore any user id in the body.
- [x] Brute-force protection: rate-limit attempts per user + IP (e.g. 10/min)
      and lock a user out of the session after ~10 wrong codes.
- [x] Staff override: organizer adds someone without a phone by scanning their
      dashboard QR (`resolveAttendee` + `CheckInStation`), `method: "staff"`.
      The same event check-in rule applies; there's no override for it.
- [x] Stats: signed up vs attended vs walk-ins, attendance CSV.

**Raffle**
- [x] Eligible pool = this workshop's attendees who are **checked in to the
      event**, filtered again at draw time (`raffleEnabled` on the workshop).
      Optional event-wide cap: max raffle wins per attendee across all
      workshops (optional event-wide cap deferred).
- [x] `POST /api/workshops/:id/raffle/draw { count, prize }`
      (`canManageWorkshop`): pick `count` distinct winners with
      `crypto.randomInt`, excluding this workshop's previous winners. Store
      every draw (who drew, when, prize, pool size, winners) for audit.
- [x] Claiming: organizer marks a winner `claimed`, or `redraw` for a no-show.
      A redraw excludes the no-show and is recorded too.
- [x] **When:** the raffle goes up **after the workshop ends** (the draw
      button unlocks at `endsAt`; organizers can override for workshops that
      finish early). Only attendees can win (decided): people who entered the
      attendance code and are event checked-in. Seeing materials or signing
      up doesn't enter you.
- [x] **Winner email** (built-in template `raffle_winner`, via B26): "You won
      <prize> at <workshop>. Collect it from the **organizer room**
      (<location>) after the workshop." The organizer room's name and location
      come from a new `OrgSettings.organizerRoom` (e.g. "Organizer room, S120,
      open 9am–9pm"), so each hackathon sets its own. Also show it as a "You
      won …" card on their dashboard (F17).
- [x] Admin view across workshops: all draws and winners, for prize stock.
- **Don't repeat:** don't reuse the old `redeem_code` pattern (B17). A
  workshop code only ever records attendance.
- **Depends on:** B18, B26. **Related:** F17, F18, T9.

---

## Hardware

### B22. Hardware inventory + checkout (replaces B10)
- [x] Checkout team snapshots, current-team change indicators, team CSV column, event return deadline and one-time membership-change return emails.
Port the old dashboard's hardware lab. Staff (mods + admins) check items out
by scanning the attendee's QR (the same code as check-in and meals) and
check them back in on return.
- [x] `schemas/hardwareItem.js`: `name`, `category`, `description`, `link`,
      `location` (bin/shelf), `imageUrl`, `totalQty`, `availableQty`,
      `maxPerAttendee`, `trackUnits`.
- [ ] Optional `schemas/hardwareUnit.js` for expensive items tracked one by one
      (`item`, `label`/barcode, `status`). Labels: printable QR per item/unit
      via `utils/qrCode`. The old dashboard printed barcode CSVs.
- [x] `schemas/hardwareCheckout.js`: `user`, `item`, `unit?`, `checkedOutBy`,
      `checkedOutAt`, `dueAt`, `returnedAt?`, `returnedTo?`, `notes`
      (collateral held, condition). **Never delete rows**: returning sets
      `returnedAt`, which is the history (the old app deleted checkouts and
      kept a separate log).
- [x] Checkout `POST /api/staff/hardware/checkouts { qrId | userId, itemId,
      unitId? }`. Resolve the attendee with the shared `resolveAttendee`, and
      require **event checked-in**. Take stock atomically:
      `HardwareItem.findOneAndUpdate({ _id, availableQty: { $gt: 0 } }, { $inc: { availableQty: -1 } })`.
      Enforce `maxPerAttendee` against open checkouts. Put stock back if
      anything after that fails.
- [x] Return `POST /api/staff/hardware/checkouts/:id/return`: idempotent (a
      second call is a no-op, not a second `+1`).
- [x] Staff lists: by item (who has it), by attendee (scan QR → their open
      items, for a fast return), outstanding/overdue; CSV export.
- [x] Inventory CRUD (`isAdmin`) + CSV import for the initial stock count.
- [x] Email checkout/return receipts and "please return" reminders through
      B26 (this replaces the old Slack DMs).
- **Don't repeat (old dashboard):**
  - `HardwareCheckoutsController` had **no permission check**: any logged-in
    attendee could check items out to anyone, or "return" any checkout by id.
  - Stock was `count -= 1; save` (two simultaneous checkouts of the last unit
    both succeed), decremented **before** the checkout saved, so a failed
    save lost a unit for good; the failure branch never responded.
  - Inverted Slack condition: `!SLACK_ENABLED && has_slack?` sent the
    checkout DM only when Slack was **off**.
  - "Message everyone with this checked out" with a search ran
    `where("... LIKE lower(?)")` with no bound value, so it crashed every
    time.
  - Attendees were identified by typing their email, not scanning, and could
    take hardware without being accepted or checked in.
- **Depends on:** B25 (feature flag); check-in from `feature/qr-checkin`.
  **Related:** F20, T10.


Implemented in the hardware working tree. Optional individual unit tracking and
the reserve/request queue are deferred. Printable labels identify item types.

### B23. Participant hardware views
- [x] `GET /api/hardware` (accepted attendees): inventory with availability,
      category filter, search. Never shows who has an item.
- [x] `GET /api/hardware/mine`: my open + returned checkouts, due times.
- [ ] Optional: request/reserve an item for pickup (a queue staff see on the
      checkout screen). Neither old platform had this; build only if
      organizers want it.
- [x] **Facilities:** an admin-editable list of on-site resources that aren't
      checked out (makerspaces, soldering, 3D printing, laser cutter, …;
      `hum-xii` had this as a static page), with location and access notes.
- **Depends on:** B22. **Related:** F20.

Implemented in the hardware working tree. Optional individual unit tracking and
the reserve/request queue are deferred. Printable labels identify item types.

---

## Judging (merge HackUMass-Judging-New; replaces B11)

The judging platform we used in Nov 2025
([gamer-1478/HackUMass-Judging-New](https://github.com/gamer-1478/HackUMass-Judging-New))
works **completely differently** from the old Rails dashboard's judging
(tags, mass-assign, paper forms). These tasks merge the 2025 platform into
this dashboard. Read "How it works" first; every subtask maps to one of its
phases.

### How the 2025 judging platform works

| # | Phase | What happens | Where in the old repo |
| - | ----- | ------------ | --------------------- |
| 0 | Setup | Judges come from `judges_auth.csv` (name, email, plaintext password, hardware flag). Rooms and capacities are hard-coded `ROOM_CONFIG` (6 rooms: S110 33, S131 49, S120 33, S140 40, N101 22, and the hardware room N155 31), duplicated in two files plus `roomNumberToName`. | `server.js`, `routes/checkinRouter.js`, `utils/helper.js` |
| 1 | Team import | Devpost CSV → one `Team` per project (name, submitter email, category, up to 4 members, MLH tracks, Devpost link, hardware flag). Each team is emailed a QR (`base64(submitter email)`) and a link to step 2. | `GET /uploadTeams` |
| 2 | Desk check-in ("checkin1") | An organizer scans the team's QR. In a Mongo transaction with retries, the team gets the **next table**: rooms fill in order, hardware teams go to the hardware room, and table numbers are **global and continuous across rooms** (room 2 starts at 34). The team is emailed its table and room. | `POST /api/checkin1` |
| 3 | Table check-in ("checkin2") | At their table, the team opens their link and scans the **QR printed on the table** (`sha256("Table N")`), which proves they're sitting at the right table. **Only teams that finish both check-ins get judged.** | `GET /checkin2/:base64email`, `POST /api/checkin2` |
| 3b | Fallback | "Check-in has failed": bulk-assign every team a table and mark both check-ins done. | `GET /checkin-has-failed` |
| 4 | Calibration ("tutorial") | Each judge scores the **same 3 practice projects**. Bias = the judge's average of the 5 general criteria minus all judges' average for that round, averaged over rounds; the same for the category criterion. | `GET/POST /tutorial`, `GET /update-bias-scores` |
| 5 | Assignments | Two separate runs (regular teams/judges and hardware teams/judges), **3 judgings per team**, **time-slotted**: judges start in rooms in proportion to room capacity and move room to room in phases. No two judges at one table in the same slot; no judge sees a team twice; load within ±2. A verifier checks the result; up to 10 attempts. Each judge's queue is stored as a list of table numbers. | `utils/judging-api.js`, `GET /generate_assignments` |
| 6 | Judging | A judge sees one team at a time, in slot order: name, table, room, category. They score **6 criteria** (Innovation 0–10, Functionality 0–10, Practicality 0–5, Presentation 0–10, Q&A 0–5, Category fit 0–10) plus comments, or **skip** and come back from the Skipped list; there's also an assignment sheet. | `routes/dashboardRouter.js`, `views/judge.ejs` |
| 7 | Progress | The "leaderboard" is **judging progress** per table (scores in / assigned), not a ranking. | `GET /leaderboard` |
| 8 | Results | **Not built.** Bias was computed but never applied; the only export is a commented-out CSV dump. Winners were worked out outside the app. | `server.js` (commented out) |

### What carries over, and what changes

| 2025 platform | In the dashboard |
| ------------- | ---------------- |
| Judges in a CSV with plaintext passwords | Dashboard users with the `judge` role (B47), invited by admins |
| A team QR emailed per team (`base64(email)`) | **No new QR:** desk staff scan any team member's existing attendee QR (`resolveAttendee` from check-in) |
| Table QR = `sha256("Table N")` | A random token per table, stored, printed on table signs |
| `ROOM_CONFIG` in code | `JudgingRoom` documents edited by admins |
| `Team` with `Mem1Name..Mem4Email` columns | `Project` with `members: [User]`, matched by email on import |
| Scores as `score1..score6` | A configurable rubric (same 6 criteria seeded by default) |
| SendGrid + EJS emails | Our mailer + editable built-in templates (B26) |
| Destructive `GET` links, open to every judge | Admin-only `POST` endpoints |
| Results in a spreadsheet | Bias-adjusted results in the app (B24g) |

### Bugs in the final 2025 commit (don't port the code as-is)
The last commit can't run several of its own admin routes. Treat the repo as a
**spec**, not code to copy.
- `/uploadTeams` uses `CsvfileTeams`, `QRCode` and `sgMail`, none of which is
  defined in `server.js`. `/check-failed-emails` uses an undefined `client`.
  `/checkin-has-failed` calls `getNextAvailableTable`, which lives only in
  `checkinRouter.js`.
- `/update-bias-scores` saves through an undefined `User` (the import is
  `userSchema`), so **bias values are never stored**.
- `POST /api/checkin1` uses `mongoose`, `ejs`, `path` and `roomNumberToName`
  without importing them, so the desk check-in throws before doing anything.
  (That's likely why the bulk "check-in has failed" fallback exists.)
- `utils/judging-api.js` is ES-module syntax (`export function`) loaded with
  `require`; it only works on Node versions that auto-detect ESM.
- **Verifier:** `_fixUnderJudgedProjects` appends extra slots without checking
  for clashes at the new slot, and `verifyAll` then reports success **without
  re-running** the simultaneous-judging, same-start and workload checks. A
  "valid" assignment set can contain clashes.
- **Rejudge advances the queue:** scoring a skipped team through
  `/rejudge/:table` posts to the normal submit, which increments
  `currentProject`, so the judge's next real team is silently skipped.
- **Assignment sheet** loops from index 1, so every judge's first team is
  missing, and "judged" is decided by position rather than by what was scored.
- Scores are validated only in the browser. The server accepts anything,
  doesn't check the judge was assigned that team, allows duplicate scores per
  judge and team, and hangs (crashes) when a table number doesn't exist.
- Judges are looked up by **name** when assignments are saved; two judges with
  the same name overwrite each other.
- Import: `team.TeamMem1First || "" + " " + team.TeamMem1Last || ""` only ever
  stores the first name (operator precedence), and the CSV header repeats
  `TeamMem1*` four times, so members 2–4 are lost. `HardwareJudge.toLowerCase()`
  crashes when the column is empty.
- Also from the earlier review: CSV logins and `GET /auth/user` returning the
  judge's password (B16); `moment().format('… HH:MM:SS')` (`MM` is the month)
  computed once at startup; guessable check-in links; 50 MB body limit;
  sessions with `sameSite: 'none'` and CORS allowing any origin with
  credentials; unused `openai`, `ai` and SendGrid dependencies.

### Merge plan
Module layout (our conventions: Express 4, CommonJS, named handlers,
`routes → controllers → schemas`, JSDoc):

```
backend/
  routes/judging.js              /api/judging/*        (isJudge)
  routes/adminJudging.js         /api/admin/judging/*  (isAdmin)
  controllers/judgingController.js
  controllers/adminJudgingController.js
  schemas/judgingRoom.js  project.js  judgeProfile.js  judgingAssignment.js
          judgingScore.js  judgingSettings.js  prize.js
  utils/judging/assignments.js   (pure: generator + verifier)
  utils/judging/bias.js          (pure)
  utils/judging/results.js       (pure)
```

Order: **B47 (judge role) and B24a (port the algorithms) can start in
parallel**; then B24b → B24c → B24d/B24e → B24f → B24g → B24h; B24i last.
Each is one PR, behind the `judging` feature flag (B25) until B24i.

### B24a. Port the algorithms as pure modules (do first)
- [x] Copy `generateJudgingAssignments` + `AssignmentGenerator` +
      `AssignmentVerifier` from `utils/judging-api.js` into
      `utils/judging/assignments.js`, converted to CommonJS, with no `console.log`
      noise (return a `log` array instead). `utils/judging-assignments.js` (the
      CLI/demo version) is not used by the app; don't port it.
- [x] **Characterization tests before changing anything** (T11): run it on the
      2025 shape (the 5 regular rooms 33/49/33/40/22 + hardware room 31,
      ~160 teams, 3 judgings per team) with a seeded RNG, and snapshot the
      invariants.
- [x] Make randomness injectable (`rng` parameter, default `Math.random`) so
      tests are deterministic.
- [x] Then fix the verifier: after `_fixUnderJudgedProjects`, re-run **all**
      checks; place fixes only where the slot is free; fail loudly if it can't.
- [x] Extract the bias formula from `/update-bias-scores` into
      `utils/judging/bias.js` (`computeBias(tutorialScoresByJudge, rubric)` →
      `{ judgeId: { general, category } }`). Keep the formula identical so the
      2025 numbers can be reproduced.
- Pure modules and algorithm tests complete; API/database wiring remains in later tasks.
  Compact legacy queues are retained; `slots` preserves empty time slots.
- **Depends on:** none. **Related:** T11.

### B24b. Rooms, projects and the Devpost import
- [x] `schemas/judgingRoom.js`: `name` (e.g. "S131"), `order`, `capacity`
      (tables), `hardware: Boolean`. Admin CRUD. This replaces `ROOM_CONFIG`
      and `roomNumberToName`.
- [x] `schemas/project.js`: `name`, `devpostUrl`, `submitterEmail`,
      `members: [User]`, `unmatchedMembers: [{ name, email }]`,
      `category` (the judged track), `optInPrizes: [String]`, `mlhTracks`,
      `hardware: Boolean`, `needsPower: Boolean`, `room`, `tableNumber`,
      `deskCheckedInAt`, `tableCheckedInAt`, `withdrawn`. Unique index on
      (`room`, `tableNumber`) for projects that have a table. Name it
      `Project`, not `Team`: the unused `schemas/team.js` (B15) is a different
      thing.
- [x] **Devpost import (decided: projects come from Devpost; no in-dashboard
      submission):** `POST /api/admin/judging/import` (multipart CSV) → parse
      by **column position + header**, because Devpost repeats member column
      names → validate each row → return a **preview** (new / updated /
      unchanged / errors, unmatched member emails) → `POST …/import/:id/confirm`
      applies it. Re-importing updates by Devpost URL and never duplicates.
      Match each project to a dashboard **team by its Devpost URL** first (B15:
      teams save their link on the Team tab), then members to users by email
      (case-insensitive); report the rest.
- [x] The hardware flag and category come from Devpost columns; admins can
      override per project.
- Admin routes and screen use the existing admin guard. Judge roles, table check-in, assignments and scoring remain outside B24b.
- Import previews expire after 30 minutes. Confirmation is uploader-only and single-use.
- Raw Devpost aliases are conservative; unknown columns are shown for review.
- Verification: syntax, frontend lint and database-free CSV/preview tests pass. Mongo integration checks, production font fetching and UI screenshots need an environment with local ports/network access.
- **Related:** F21c.

### B24c. Two-step team check-in (desk → table)
Keep the 2025 flow: it makes sure teams are physically at the table judges
will walk to.
- [x] **Desk check-in** (phase 2): `POST /api/staff/judging/desk-checkin
      { qrId }` (moderators + admins). Resolve the attendee from their QR with
      the shared `resolveAttendee`, find their project (409 if they're on
      several; staff pick one), and assign the next table **inside a
      transaction**. Keep the 2025 logic: rooms in `order`, hardware projects
      → hardware rooms, global continuous numbering, room full → clear error.
      Rely on the unique index + retry for races.
- [x] **Table signs:** `GET /api/admin/judging/table-signs` → a printable PDF/HTML
      sheet per table with a big table number, room, and a QR holding a random
      per-table token (stored on a `JudgingTable` record or in the room's
      table list).
- [x] **Table check-in** (phase 3): a logged-in team member scans the table QR
      on their dashboard → `POST /api/judging/table-checkin { token }`. It must
      match their project's assigned table, otherwise "Wrong table: you're at
      table 12, go to table 34 in S131". Desk check-in is required first.
- [x] Email the team their table + room after desk check-in (built-in template
      `judging_table_assigned`, via B26).
- [x] **Fallback** (phase 3b), admin-only `POST`: bulk-assign tables to every
      project and mark both steps done, with a confirmation that states the
      count.
- [x] Undo for mistakes: admin can clear a project's table (frees the number,
      logged).
- Implemented with transaction fallback for standalone MongoDB, global unique index and retry, persistent tokens, count-confirmed bulk fallback and durable undo audit. Bulk fallback may complete earlier projects before a capacity failure; retry resumes remaining projects. Room layout is locked after signs or assignments exist.
- Integration tests written but not run here (no MongoDB). Light/dark/mobile screenshots and device scanning remain to verify in a running environment.
- **Depends on:** B24b; check-in from `feature/qr-checkin`.

### B24d. Judge calibration (tutorial) and bias
- [ ] `JudgingSettings.calibrationProjects` (default 3, matching 2025): each
      has a title and an optional description or link. All judges score the
      same ones, in the same order, typically at the judges' briefing.
- [ ] `schemas/judgeProfile.js` (one per judge user): `user`, `hardware`,
      `calibrationScores: [{ round, scores, comments }]`, `bias: { general,
      category, computedAt }`.
- [ ] `POST /api/judging/calibration/:round` (isJudge): rubric-validated,
      **upsert** per round (rescoring replaces), rounds in order.
- [ ] `POST /api/admin/judging/bias` runs `utils/judging/bias.js` over everyone
      who finished calibration and stores the result. Judges who skipped
      calibration get `bias: null` and are flagged in results (B24g).
- **Depends on:** B24a, B47.

### B24e. Assignment generation (versioned)
- [x] `POST /api/admin/judging/assignments { judgingsPerProject = 3, slotMinutes = null }`: take
      projects with **both** check-ins, split into regular and hardware pools
      (hardware projects only get `hardware` judges), and run the ported
      generator per pool, with rooms and capacities from `JudgingRoom`.
- [x] Store the result as a new `JudgingAssignment` version: `{ version,
      createdBy, createdAt, params, verifierReport, queues: [{ judge,
      projects: [Project] }] }`. Judges keyed by **user id**, not name. Refuse
      to save a set that fails the verifier; return the report.
- [x] Activate a version explicitly. Regenerating or activating a new version
      never deletes scores: scores for projects still in a judge's new queue
      count as done; others stay in results.
- [x] Late changes without regenerating everything: add or remove a judge, and
      withdraw a project (removes it from all queues).
- [x] **Decision (a):** keep the slot-based generator and optional per-slot countdown (`slotMinutes`, null means no timer). Actual occupied tables are mapped to configured rooms and capacities, including vacancies.
- **Depends on:** B24a, B24c, B47.

### B24f. Judge queue and scoring
- [x] Rubric adapter `utils/judging/criteria.js#getCriteria()` supplies the six default criteria with help, ranges, weights and kind. Settings storage/editing belongs to the parallel B24d branch; no JudgingSettings is created here.
- [x] `GET /api/judging/queue` (isJudge): current project (name, table, room,
      category, Devpost link), position "4 of 12", skipped list, done list.
- [x] `POST /api/judging/scores { projectId, scores, comments }`: every
      criterion present, an integer within its range (the server enforces this
      now); the project must be in the caller's active queue (403 otherwise);
      **upsert** on (judge, project). Submitting **only advances the queue when
      it's the current project**, so rescoring a skipped team never jumps past
      the next one (the 2025 bug). Unknown project → 404.
- [x] `POST /api/judging/skip` (current → skipped), and scoring a skipped
      project removes it from skipped.
- [x] Freeze: once an admin closes judging, every score write → 409.
- **Depends on:** B24e.

Implementation notes: generation is inactive until explicitly activated. Regular and hardware judges form separate pools. Late additions use explicit eligible project ids and append slots after the existing schedule; additions/removals can change coverage and the stored report describes the original generation. Scores survive all assignment changes. Demotion/removal also prunes the active queue. Database writes and freeze share a singleton lock; see backend/README.md for recovery after a process crash.

### B24g. Progress board, results and exports
- [ ] **Progress** (the 2025 "leaderboard"): `GET /api/admin/judging/progress`,
      per project scores in / assigned, per judge done / total, and the
      projects still missing scores. Visible to moderators and admins.
- [ ] **Results** (missing in 2025): `GET /api/admin/judging/results`, admin
      only. Per project: number of scores; the raw general total (weighted
      sum of the `general` criteria); the **bias-adjusted** total (subtract
      each judge's general bias before averaging); the category score raw and
      bias-adjusted; and flags (fewer scores than `judgingsPerProject`, judges
      without calibration). Rank overall and per category. Implement in
      `utils/judging/results.js` (pure) so it can be tested.
- [ ] CSV exports: all scores (the dump 2025 had commented out), results,
      per-judge progress.
- **Depends on:** B24d, B24f.

### B24h. Prizes and winners
The old Rails dashboard had prizes as data; 2025 handled them outside the app.
- [ ] `schemas/prize.js`: `name`, `sponsor`, `description`, `category` (the
      judged track it maps to, or none for sponsor prizes), `quantity`,
      `winners: [Project]`.
- [ ] Admin CRUD. Projects' prize opt-ins come from the Devpost import.
- [ ] Assign winners from the results (B24g), suggested by category rank; then
      publish (winners page + email the winning teams).
- **Don't repeat:** the old `prizes` controller guarded `show`/`new`/`edit` but
  **not** `create`/`update`/`destroy`, so any logged-in user could change
  prizes by POSTing directly.
- **Depends on:** B24b, B24g.

### B24i. Cut-over and decommission
- [ ] Dry run on a staging copy before the event: import last year's Devpost
      export **with emails replaced**, run check-in → calibration →
      assignments → scoring with test judges, and compare the results against
      a hand calculation.
- [ ] Turn on the `judging` feature flag for the event.
- [ ] Archive the old repo once B16 is done (credentials rotated, history
      purged). **Don't import 2025 data**; it's last year's event, and its
      files must not be copied into this repo.
- [ ] Update `feature-parity.md`, `README.md` and `AGENTS.md` (roles).
- **Depends on:** B24a–B24h, B16.

---

## Finance

No old platform had budgets or organizer expenses. The only finance code ever
written is a 2018 travel-reimbursement branch that was never merged (B39).
This is a new design. **Rules for every finance task:**
- Money is an **integer number of cents** plus a currency code (default
  `USD`, per deployment). Never floats; the 2018 code used `float`.
- Only **moderators and admins** see finance; it's invisible to applicants,
  judges and workshop organizers (T12).
- Every status change is appended to the record's history (`status`, `by`,
  `at`, `note`). Records are voided, never hard-deleted.
- **Nobody approves or pays their own reimbursement**, admins included.
- Receipts are private (same Azure private container + short-lived SAS URL
  pattern as B20).

### B33. Organizer teams
- [ ] `schemas/orgTeam.js`: `name` (Logistics, Food, Marketing, Tech, …),
      `description`, `members: [User]`, `leads: [User]`.
      Members must be moderators or admins: enforce on add, and when someone
      is demoted, flag them on their teams for an admin to remove.
- [ ] Admin CRUD + membership (`/api/admin/teams`). A person can be on several
      teams.
- [ ] `utils/isTeamMember` guard: admins pass; otherwise the caller must be a
      member of the team in `req.params` (or of the team that owns the budget
      line being touched).
- [ ] General-purpose: later tasks can reuse teams (e.g. hardware desk or
      check-in shifts).
- **Depends on:** none. **Related:** F23, T16.

### B34. Budget and budget lines
- [ ] `schemas/budget.js`: `name` (e.g. "HackUMass XIII"), `currency`,
      `periodStart`/`periodEnd`, `status` (`open` | `locked`). Locking makes
      everything under it read-only once the books close.
- [ ] `schemas/budgetLine.js`: one **component** of the budget (Catering,
      Venue, Swag, Prizes, Travel, …): `budget`, `team` (B33, the owner),
      `name`, `category`, `allocatedCents`, `notes`.
- [ ] Admin CRUD. Changing `allocatedCents` records a reallocation entry
      (old → new, who, why).
- [ ] Computed per line, per team and per budget:
      **allocated**; **committed** (open hackathon-paid expenses + submitted
      or approved reimbursements); **spent** (closed expenses + paid
      reimbursements); **remaining** = allocated − spent − committed.
      Flag lines that are over budget.
- [ ] `GET /api/finance/summary`: admins get everything. **Moderators get only
      their own teams**: their teams' totals and lines. They never see other
      teams' totals, line items or expenses, the budget-wide total, or
      income (B38). Filter on the server, not in the UI; a moderator
      requesting another team's summary gets 403.
- **Depends on:** B33. **Related:** F23, F24.

### B35. Team expenses
Any moderator or admin can add an expense to a budget line owned by one of
their teams (admins: any line).
- [ ] `schemas/expense.js`: `budgetLine`, `team` (copied from the line),
      `submittedBy`, `vendor`, `description`, `amountCents`, `currency`,
      `incurredAt`, `paidBy` (`hackathon` | `personal`),
      `receipts: [{ blobName, name, size, contentType }]`, `status`,
      `history`, `closedAt`, `closedBy`.
- [ ] **`paidBy: "hackathon"`** (org card, an invoice the university or
      student government pays, a purchase order): starts `open`, which counts
      as **committed**. Any member of the owning team, or an admin, marks it
      **`closed`** once the hackathon has paid; it then counts as **spent**.
      Closing requires a receipt or invoice (configurable), and is recorded
      with who and when.
- [ ] **`paidBy: "personal"`**: the person paid out of pocket, so it's a
      reimbursement request and follows B36.
- [ ] Editable by the submitter or an admin only while `open`/`submitted`.
      After approval or closing, changing the amount means **reopening**
      (admin, with a reason, recorded in history).
- [ ] Void instead of delete (`status: "voided"`, reason required).
- [ ] Receipts: multipart upload (pdf/jpg/png/heic, ≤10 MB each), private blob
      storage, download through an access-checked SAS redirect.
- [ ] List and filter by team, line, status, payer, date; mods see their
      teams' expenses plus their own.
- **Depends on:** B33, B34. **Related:** F24, T16.

### B36. Reimbursements and money owed
All moderators and admins can submit reimbursement requests; admins track and
pay out what's owed.
- [ ] Submitting = creating a `paidBy: "personal"` expense (B35) on a line of
      one of the submitter's teams; a receipt is **required**. **Decision
      needed:** allow "uncategorized" requests for admins to file later?
      Recommend no: pick a line; admins can move it.
- [ ] States: `submitted` → `approved` | `rejected` (reason required) →
      `paid` (closed). The submitter can `withdraw` while `submitted`.
      Enforce these transitions in one place (`utils/expenseStatus.js`); any
      other transition gets a 409.
- [ ] **Separation of duties:** the approver and the payer must not be the
      submitter, even for admins. With a single admin, finance actions on that
      admin's own requests are blocked until a second admin exists. Say so in
      the error.
- [ ] Payment record: `paidAt`, `paidByUser`, `method` (check, Venmo, Zelle,
      direct deposit, university reimbursement form), `reference` (check
      number / transaction id), `note`. **Don't store bank or account
      numbers.** A submitter's payout handle (e.g. Venmo username) lives on
      their profile and is visible only to admins.
- [ ] Batch payout: mark many approved requests `paid` in one action with a
      shared reference (a weekly payout run).
- [ ] **Owed** view for admins (`GET /api/admin/finance/owed`):
      approved-but-unpaid total (the money still to be paid out), submitted
      awaiting review, per person owed, per team, oldest first, with age in
      days.
- [ ] Email the submitter on every transition (B26).
- **Depends on:** B35. **Related:** F25, T16.

### B37. Finance reports and exports
- [ ] CSV exports: expenses (any filter), reimbursements with payment details,
      budget vs actual by team and line.
- [ ] Receipts bundle: a zip of every receipt in a date range, named
      `<date>_<vendor>_<amount>`, for the university finance office.
- [ ] Spend over time per team (for the F24 chart).
- **Depends on:** B34–B36.

### B38. Funding and income
- [ ] `schemas/income.js`: `budget`, `source` (sponsor, grant, university,
      other), `name`, `amountCents`, `status` (`pledged` | `received`),
      `receivedAt`, `notes`. Admins enter it by hand. Show funded vs
      allocated vs spent per budget. **Admin only**; moderators never see
      income (B34).
- HackerForce (the old sponsorship CRM) is **not** being merged or
  integrated.
- **Depends on:** B34.

### B39. Attendee travel reimbursements (not this year)
The 2018 `hackumass-web` branch `travel-reimbursements` let attendees file
travel claims with a receipt, grouped into travel groups (name, budget
amount, departure city); organizers toggled "approved", had "approve all", and
printed cost sheets. It was never merged.
- **Decided: not offered this year.** Nothing to build. If it comes back,
  reuse the B36 pipeline: attendees submit their own requests only, against a
  "Travel" budget line, with caps per travel group or region, and admin
  approve + pay.
- **Don't repeat:** `approved` was in the submitter's permitted form fields, so
  anyone could approve their own claim. `update`/`destroy` had no owner
  check. Money was a `float`.
- **Depends on:** B36.

---

## Registration gaps (found in the parity review)

### B40. Email verification on sign-up
The old dashboard confirmed emails (Devise `confirmable`); we didn't, so anyone
could register with someone else's address, and their acceptance QR goes there.
- [x] Send a verification link on register (token hashed in the DB, like the
      reset token; 24 h expiry); `POST /api/auth/verify-email`; resend
      endpoint (rate-limited).
      Built: `POST /api/auth/register` stores `emailVerified: false` plus the
      SHA-256 of a random token and emails `{{verifyUrl}}` (new built-in
      `verify_email` template). `POST /api/auth/verify-email` `{ token }` is
      public, atomic and single-use. `POST /api/auth/resend-verification`
      (logged in) is limited per IP (`AUTH_RATE_LIMIT_MAX_RESEND_VERIFICATION`)
      and to one email a minute per account.
- [x] Applying requires a verified email. Google sign-ins count as verified.
      Built: `POST /api/applications` answers 403 `{ code:
      "EMAIL_NOT_VERIFIED" }` (drafts too) via the `isEmailVerified` guard,
      which reads the flag from the database so verifying takes effect
      without logging in again. Google sign-in marks the account verified.
      Setting a password through any emailed link (reset, or the first-password
      link sent to people who applied without an account) also verifies it.
- [x] Existing users: treat as verified (or re-verify on next login: decide).
      **Decided: treat as verified.** `User.emailVerified` defaults to `true`,
      so accounts with no stored flag (everyone created before this) and every
      path other than password sign-up stay verified; no migration, nobody is
      locked out. Only `register` and the no-account application form create
      unverified accounts.
- Follow-ups outside this task: **people who apply without an account** are not
  verified at application time (there is no inbox proof until they set a
  password), so their decision emails still go to an address nobody has
  confirmed; closing that needs a "confirm to submit" step on the public form.
  Verification is enforced only while outgoing email is configured (otherwise
  the link could never be delivered and applications would lock for everyone);
  an explicit on/off setting could be added if an organiser wants it off with
  email on. Unverified accounts are not purged.
- **Depends on:** none.

### B41. Waitlist email and waitlist mode
- [x] Deciding "waitlisted" currently sends **no email**: `DECISION_TEMPLATE_KEYS`
      in `adminController` only has accepted/rejected. Add a built-in
      `application_waitlisted` template and send it.
- [x] Optional waitlist mode (the old dashboard had it): once a round reaches a
      configured number of accepted applicants, new applications are
      waitlisted automatically and told so.
- **Status:** done. Built-in `application_waitlisted` template, sent on a
  reviewer's "waitlisted" decision (once; repeating it is a no-op). Waitlist
  mode is a per-round `waitlistAfterAccepted` (whole number of 1+, empty = off;
  `POST`/`PATCH /api/admin/rounds`, admin only, hidden from applicants). When a
  round has that many accepted applications, a *first submission* (draft ->
  submitted, or a new application, with or without an account) is saved as
  `waitlisted` and the applicant gets the waitlist email instead of "received".
  Already-submitted applications are never moved, reviewers can still accept
  past the limit, and nobody is promoted automatically. **Behaviour change:**
  re-submitting an already submitted application (an edit) now keeps its review
  status; before, every edit reset it to `pending`, which would have undone
  acceptances and taken people off the waitlist. Tests: `test/waitlist.test.js`.
- **Depends on:** none.

### B42. Flag suspicious applications
- [x] `Application.flagged`, `flagReasons: [String]`, `flaggedBy`; moderators
      can flag/unflag with a reason; review list filter + count.
- [x] Optional automatic checks on submit: resume text too short, resume
      doesn't mention the applicant's name, duplicate phone or resume across
      accounts.
- **Don't repeat:** the old auto-flag (`event_application.rb`) had a misplaced
  `!` in its university/major check, so it flagged the wrong applications.
  Write the rule as a small pure function with tests.
- **Status:** done. Moderators: `POST` / `DELETE /api/admin/applications/:id/flag`
  (reason required, max 300 chars); `GET /api/admin/applications?flagged=true`
  and a `flaggedCount` in the list response; the list rows carry only
  `flagged` (reasons and `flaggedBy` come with the full application). Flags
  are staff-only: the Application JSON that applicants get never includes
  them (opt-in `toJSON({ includeFlags: true })` for the moderator routes).
  Automatic checks run on an application's first submission only, behind the
  admin setting `autoFlagApplications` (off by default; flags are labels, they
  never block or reject): `utils/applicationFlags.js` holds the rules as pure
  functions with truth-table tests, `utils/resumeText.js` reads PDF/Word text.
  Resume text is read **without a parsing dependency** (untrusted uploads, B30),
  so it only covers Word files and PDFs whose text is plain strings (TeX, Word,
  Quartz, groff); PDFs that store glyph numbers (Chrome, Google Docs, Skia),
  encrypted or damaged files, and old `.doc` are "unreadable" and skip the
  text rules instead of being flagged. Duplicate phone / resume use stored
  fingerprints (`phoneKey`, `resumeHash`), so only applications submitted after
  this lands can be matched. Tests: `test/flaggedApplications.test.js`,
  `test/resumeText.test.js`.
- **Depends on:** none.

### B43. Admin statistics
- [x] `GET /api/admin/stats` (admin only): applications by status and round,
      by school/education level/gender/major/T-shirt size/graduation year,
      first-time hackers, submissions per day (stacked by status, in the
      event's time zone), plus every custom choice question on the forms;
      on event day, checked-in count (and forced walk-ins) and meals served.
      Optional `?round=` and `?status=` scope the breakdowns. Graduation
      year isn't a built-in field, so it is found among the rounds' custom
      questions (label or key says graduation / grad year / class of).
- [ ] Workshop attendance and hardware out. The endpoint already returns
      `eventDay.workshopAttendance` and `eventDay.hardwareOut` as `null`; fill
      them in `statsController.eventDayStats` when B21 and B22 exist.
- [x] Aggregations in Mongo (`$group`), not loading every document (a test
      fails if `Application.find` is called).
- **Depends on:** none. **Related:** F26.

### B44. Force check-in (admin override)
- [ ] Admins can check in someone whose application isn't accepted (a walk-in
      approved at the desk), with a required reason, recorded on the CheckIn.
      The old dashboard had this, but as a client-side `force_check_in` flag
      anyone could send; ours must check `isAdmin` on the server.
- **Depends on:** check-in on `feature/qr-checkin`.

### B45. Public schedule feed for the hackathon website
- [x] `GET /api/public/schedule` (no auth, cached): published run-of-show
      items, so the hackathon website (e.g. `fuseumass/hackumass-website`)
      can show the live schedule instead of copying it. Also a public
      `GET /api/public/schedule.ics` of the same. `ScheduleEvent.published`
      (default off, so nothing goes public by accident) is set from the Run of
      show page. Cached 30 s in memory (cleared on admin edits) and
      `Cache-Control: public, max-age=60`; open CORS (`*`, no credentials) on
      `/api/public` only.
- [ ] Published workshops in the same feed (and the `.ics`): add them in
      `utils/publicSchedule.js` `load()` once the Workshop model exists.
- **Depends on:** B18 (for the workshops half).

### B46. Error reporting
The old dashboard reported errors to Sentry (Raven); we only `console.error`.
- [ ] Optional Sentry (or similar) via `SENTRY_DSN` on backend and frontend;
      off when unset. Scrub emails, tokens and resume URLs before sending.
- **Depends on:** none.

---

## Platform / hardening

### B28. Runtime branding API (fixes the colour flags, with F12)
The brand colour is a build-time `NEXT_PUBLIC_*` variable, so changing it on
a deployment does nothing, and there's no secondary colour at all (details in
F12). Move branding to the backend so admins can change it without a
rebuild.
- [x] `OrgSettings.branding`: `orgName`, `primaryColor`, `secondaryColor`,
      `accentColor?`, `logoUrl`, `logoDarkUrl`, `faviconUrl`. Validate colours
      as hex (`#RRGGBB`) and reject anything else; never pass raw CSS through.
- [x] Defaults from **server** env (`BRAND_PRIMARY`, `BRAND_SECONDARY`, …) read
      at request time, so one image can serve every hackathon.
- [x] Public `GET /api/meta/branding` (no auth, cacheable for ~60 s) returning
      branding + the public feature flags (B25). Logo upload via Azure.
- **Decisions:** (1) **Logos are served by the API** from a second, *private*
  container (`AZURE_STORAGE_BRANDING_CONTAINER`) at
  `GET /api/meta/branding/files/<name>`, not from a public container, so the
  storage account never needs anonymous blob access; only API-generated names
  are served, bytes are re-checked, SVG is refused at upload, and responses
  carry `nosniff` + a locked-down CSP. (2) Images can also be an admin-pasted
  `https://` URL (works without Azure). (3) Precedence per field: admin
  setting, then server env, then built-in default; env is read per request.
  (4) The org name from branding drives the UI only; emails still use the
  `ORG_NAME` env var. (5) Uploaded-logo links are root-relative unless
  `API_PUBLIC_URL` is set. (6) A 10 s in-process settings cache
  (`SETTINGS_CACHE_TTL_MS`) plus `max-age=60` keeps the endpoint off Cosmos DB.
  Details: `backend/README.md`, "Branding".
- **Depends on:** none. **Related:** F12.

### B29. CSV exports
The old dashboard could export everything; organizers rely on it for
sponsors, catering and insurance.
- [x] Admin CSV export for applications (with dynamic `answers` flattened),
      check-ins and meal counts: `GET /api/admin/exports/applications.csv`
      (`?round=&status=`), `checkins.csv`, `meals.csv`. Admin only, streamed in
      batches of 500 by `_id` (no long-lived cursor), formula-injection safe
      (`utils/csv.js`), never includes password hashes, tokens, QR codes or
      resume blob names.
- [ ] Workshop sign-ups, raffle winners and hardware checkout CSVs (need
      B19, B21 and B22). Add them as routes in `routes/exports.js` using
      `utils/csv.js` `sendCsv`.
- [x] Resume bundle export for sponsors: `GET
      /api/admin/exports/resumes.zip?consentKey=<key>[&round=<id>]`, a ZIP
      streamed from Azure of accepted applicants who ticked the checkbox
      question `consentKey` on the application form (nobody is included without
      a consent question), plus an `index.csv`. Replaces `download_resumes.py`.
      Streaming ZIP writer in `utils/zipStream.js`, no new dependency.
- **Depends on:** none.

### B30. Dependency vulnerabilities
`npm audit` in `backend/` (Oct 2026): **critical** `proxy-addr` and
**moderate** `body-parser`/`qs` (via `express`), **high** `nodemailer`,
moderate `ip-address`, moderate `csv-parse` (fix is a major bump to v7).
- [x] `npm audit fix` (non-breaking ones), run the test suite.
      *Done:* `proxy-addr`, `qs`, `ip-address` fixed; `nodemailer` 9 → 10
      (checked against the real Bird SMTP login); `multer` 1 → 2 (1.x was
      deprecated for vulnerabilities). Frontend: `next` 16.2.12 → 16.4.3
      (critical RCE advisories), `nanoid` fixed. Both `npm audit` report 0.
- [x] `csv-parse` v7 upgrade: check `metaController`'s colleges loader still
      works. *Done:* colleges.csv parses the same; tests pass.
- [x] Add `npm audit --audit-level=high` to CI (T15). *Done:* production
      dependencies, frontend and backend jobs.
- **Depends on:** none.

---

## Later / needs a decision

### B31. Mentorship tickets (on Discord, not in the dashboard)
The old dashboard had mentor tickets (attendee posts a request with a
screenshot, mentors claim and resolve). **Decided: mentorship tickets are
created on Discord**, so there's nothing to build here beyond linking to it:
- [x] Optional `ORG_DISCORD_MENTORSHIP_URL` (the mentorship channel or
      ticket-bot link), shown on the attendee home page next to the Discord
      invite. Served by `GET /api/meta/links` (login required; read from the
      env per request; only plain http(s) URLs); shown in a "Community" card
      on the home page.

### B32. RSVP / confirm attendance after acceptance
The old dashboard had an RSVP step (plus custom RSVP questions, e.g. travel,
dietary) to get real headcounts before the event. Useful for catering and
reimbursements. Spec with organizers.

### B14. colleges.csv ingestion
Document/ship the real `Backend/data/colleges.csv` (organizer-provided) and make
the loader resilient to large files (streaming if needed).
- **Depends on:** none. **Related:** existing `metaController`.

### B15. Teams (done)
Decided: `schemas/team.js` is the **hackathon team** (people building one
project), not a group application. Members invite each other by email, any
member saves the team's Devpost project link (`devpostUrl`, normalized to
`https://devpost.com/software/<slug>`, one team per project), and staff see
every team at `GET /api/admin/teams` (Teams tab, CSV export). One team per
person, unique names and unique Devpost links are enforced by indexes; the
size limit (`OrgSettings.teamMaxSize`, default 4) counts pending invites.
- **Feeds B24b:** match imported Devpost projects to teams by `devpostUrl`
  first, then by member email for teams that never saved a link.
