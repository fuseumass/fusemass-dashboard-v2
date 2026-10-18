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
- [ ] Return the applicant's most recent application across all rounds when no
      round is open (or add `GET /api/applications/me/latest`).
- [ ] Include `checkedIn` and the round name so the home page can show "You're
      in — see you at check-in" vs. "You're checked in".
- **Depends on:** none. **Related:** F22.

### B26. Email outbox: log, retry and resend
Every email today is fire-and-forget: if SMTP blips during a batch of
acceptances, those emails (and their QR codes) are lost silently. The judging
platform had to bolt on a `/check-failed-emails` page for the same reason.
- [ ] `EmailLog` schema: `to`, `templateKey`, `user`, `status`
      (`queued|sent|failed`), `attempts`, `lastError`, `sentAt`.
- [ ] `utils/mailer` writes a log row per send; retry failed sends with
      backoff (an in-process interval is fine at our scale; no new
      infrastructure).
- [ ] Admin: list failures, resend one, and **resend acceptance emails**
      (needed for anyone accepted before QR codes shipped).
- [ ] Bulk email to a segment (not applied / pending / accepted / waitlisted /
      rejected / checked in / workshop sign-ups / people still holding
      hardware / "test to myself"). This replaces the old dashboard's
      mailing lists and Slack blasts.
- [ ] **Consent:** add `User.marketingEmailConsent` (asked at sign-up,
      editable in profile, off by default) and an unsubscribe link. Bulk
      *announcement* emails go only to people who consented; transactional
      ones (decisions, QR, check-in, workshop invites, hardware receipts) always
      send. The old dashboard enforced this (`non_transactional_email_consent`)
      and had a branch for the SendGrid opt-in/opt-out rules; we don't yet.
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
- [ ] **Decision needed:** roles are a single value today, so a moderator who
      also runs a workshop can't hold both. Options: (a) allow assigning any
      staff role (mod/admin) as a workshop's organizer, with the guard
      checking the assignment rather than the role; or (b) move to a `roles`
      array. Recommend (a): smallest change, no migration.
- [ ] Judges get a `judge` role the same way (B24a).
- **Don't repeat:** the old dashboard's `redeem_code` let any attendee who
  hadn't RSVP'd or checked in become an organizer or **admin** by typing a
  code from a config file. Roles change only through admin endpoints.
- **Depends on:** none. **Related:** B18–B21, F18, F19, T12.

### B25. Feature flags per module
Let each hackathon switch modules on or off at runtime: meals, hardware,
workshops, judging, raffles. The old dashboard had this; we should too.
- [ ] `OrgSettings.features: { meals, hardware, workshops, judging, raffle }`
      (booleans, default on), editable via `PATCH /api/admin/settings`.
- [ ] `utils/requireFeature("hardware")` middleware: answers **404** for
      everyone when the feature is off (admins too, so a disabled module
      can't be half-used). Mount it on each module's router.
- [ ] Expose the flags to the frontend (public part of
      `GET /api/meta/branding`, see B28) so the nav hides disabled modules.
- **Don't repeat:** the old `check_feature_flag?` called `.value` before its
  nil check (crashed when a flag was missing). Its bypass,
  `(not admin or not organizer)`, was true for everyone who wasn't both, so
  admins were locked out too.
- **Depends on:** none. **Related:** F13.

---

## Workshops

### B18. Workshop model + admin CRUD
- [ ] `schemas/workshop.js`: `title`, `description`, `host` (speaker name),
      `location`, `startsAt`, `endsAt`, `capacity` (0 = unlimited),
      `signupCount` (kept in step with B19), `organizers: [User]`,
      `published` (hidden from attendees until true), `raffleEnabled`.
- [ ] Admin CRUD at `/api/admin/workshops` (`isAdmin`), the same pattern as
      `/api/admin/meals` and `/api/admin/schedule`.
- [ ] Attendee list: `GET /api/workshops` (published only, accepted
      applicants), each with `spotsLeft` and whether the caller is signed up.
- [ ] Changing `startsAt`/`endsAt` of a workshop with sign-ups triggers updated
      calendar invites (B19).
- [ ] Deleting a workshop with sign-ups: soft-cancel instead (`cancelled:
      true`), email the sign-ups and send calendar cancellations. Same reasoning
      as meals, which can't be deleted once served.
- **Depends on:** B17. **Related:** F17, F19.

### B19. Workshop sign-up, my workshops, calendar invites
Attendees pick and manage the workshops they're signed up for, and each one
lands in their calendar.
- [ ] `schemas/workshopSignup.js`: `user`, `workshop`, `createdAt`; unique
      index on (user, workshop).
- [ ] `POST /api/workshops/:id/signup` / `DELETE` (cancel). Only accepted
      applicants. Ignore any user id in the body; always act on `req.user`.
- [ ] **Capacity must hold under concurrency:** take a seat with
      `Workshop.findOneAndUpdate({ _id, $or: [{ capacity: 0 }, { $expr: { $lt: ["$signupCount", "$capacity"] } }] }, { $inc: { signupCount: 1 } })`,
      then create the sign-up. Roll the counter back if the unique index says
      they were already signed up. Cancelling decrements.
- [ ] Optional waitlist: when full, join a waitlist; on cancellation promote
      the first waiter and email them.
- [ ] Warn (don't block) when a sign-up overlaps another of the user's
      workshops.
- [ ] `GET /api/workshops/mine`: the caller's workshops, ordered by time.
- [ ] **Calendar invite per sign-up**, using `utils/calendar.js` from
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

### B20. Workshop announcements feed (files + posts)
A chat-style announcement channel per workshop. Organizers post slides,
starter code and links; signed-up attendees read them. It's one-way:
organizers post, attendees don't reply.
- [ ] `schemas/workshopPost.js`: `workshop`, `author`, `body` (plain text,
      URLs linkified on render, no raw HTML), `attachments: [{ name, blobName,
      size, contentType }]`, `pinned`, timestamps.
- [ ] `POST /api/workshops/:id/posts` (multipart, `canManageWorkshop`): up to 5
      files per post; size limit (e.g. 25 MB) and allowed types (pdf, pptx/key,
      docx, zip, images, ipynb, txt/md). Reuse `utils/azureBlob` with a
      **private** container.
- [ ] `GET /api/workshops/:id/posts` (newest first, cursor paginated) for
      organizers + signed-up attendees + admins. **Decision needed:** should
      every accepted attendee see materials, even without signing up?
      Recommend yes once the workshop has started (people drop in).
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
- [ ] `schemas/workshopAttendance.js`: `user`, `workshop`, `checkedInAt`,
      `method` (`code` | `staff`), `addedBy?`; unique index on
      (user, workshop).
- [ ] Attendance session: `POST /api/workshops/:id/attendance/open`
      (`canManageWorkshop`) with a duration (default 10 min); `extend` and
      `close` endpoints. One open session per workshop at a time.
- [ ] **Rotating code**, like Top Hat: 4–6 characters from an unambiguous
      alphabet (no 0/O/1/I), changing every 30–60 s so a code texted to
      friends outside goes stale. Derive it as
      `HMAC(sessionSecret, floor(now / period))` so nothing is stored per
      rotation. Accept the **current and previous** code to allow for typing
      lag.
- [ ] `GET /api/workshops/:id/attendance/code` (organizer): current code +
      seconds until it rotates, for Present mode (F18). Optionally also return
      a URL with the code embedded, for a QR attendees can scan.
- [ ] Attendee: `POST /api/workshops/:id/attendance { code }`. Only accepted
      applicants who are **checked in to the event** (`User.checkedIn`), with
      an open session and a valid code. Not checked in → 403 "Check in at the
      front desk first". A workshop sign-up is **not** required, so walk-ins
      count. Idempotent (a repeat is a 200 "already here", not an error).
      Ignore any user id in the body.
- [ ] Brute-force protection: rate-limit attempts per user + IP (e.g. 10/min)
      and lock a user out of the session after ~10 wrong codes.
- [ ] Staff override: organizer adds someone without a phone by scanning their
      dashboard QR (`resolveAttendee` + `CheckInStation`), `method: "staff"`.
      The same event check-in rule applies; there's no override for it.
- [ ] Stats: signed up vs attended vs walk-ins, attendance CSV.

**Raffle**
- [ ] Eligible pool = this workshop's attendees who are **checked in to the
      event**, filtered again at draw time (`raffleEnabled` on the workshop).
      Optional event-wide cap: max raffle wins per attendee across all
      workshops.
- [ ] `POST /api/workshops/:id/raffle/draw { count, prize }`
      (`canManageWorkshop`): pick `count` distinct winners with
      `crypto.randomInt`, excluding this workshop's previous winners. Store
      every draw (who drew, when, prize, pool size, winners) for audit.
- [ ] Claiming: organizer marks a winner `claimed`, or `redraw` for a no-show.
      A redraw excludes the no-show and is recorded too.
- [ ] Email winners (B26) and show "You won …" on their dashboard (F17).
- [ ] Admin view across workshops: all draws and winners, for prize stock.
- **Don't repeat:** don't reuse the old `redeem_code` pattern (B17). A
  workshop code only ever records attendance.
- **Depends on:** B18, B26. **Related:** F17, F18, T9.

---

## Hardware

### B22. Hardware inventory + checkout (replaces B10)
Port the old dashboard's hardware lab. Staff (mods + admins) check items out
by scanning the attendee's QR (the same code as check-in and meals) and
check them back in on return.
- [ ] `schemas/hardwareItem.js`: `name`, `category`, `description`, `link`,
      `location` (bin/shelf), `imageUrl`, `totalQty`, `availableQty`,
      `maxPerAttendee`, `trackUnits`.
- [ ] Optional `schemas/hardwareUnit.js` for expensive items tracked one by one
      (`item`, `label`/barcode, `status`). Labels: printable QR per item/unit
      via `utils/qrCode`. The old dashboard printed barcode CSVs.
- [ ] `schemas/hardwareCheckout.js`: `user`, `item`, `unit?`, `checkedOutBy`,
      `checkedOutAt`, `dueAt`, `returnedAt?`, `returnedTo?`, `notes`
      (collateral held, condition). **Never delete rows**: returning sets
      `returnedAt`, which is the history (the old app deleted checkouts and
      kept a separate log).
- [ ] Checkout `POST /api/staff/hardware/checkouts { qrId | userId, itemId,
      unitId? }`. Resolve the attendee with the shared `resolveAttendee`, and
      require **event checked-in**. Take stock atomically:
      `HardwareItem.findOneAndUpdate({ _id, availableQty: { $gt: 0 } }, { $inc: { availableQty: -1 } })`.
      Enforce `maxPerAttendee` against open checkouts. Put stock back if
      anything after that fails.
- [ ] Return `POST /api/staff/hardware/checkouts/:id/return`: idempotent (a
      second call is a no-op, not a second `+1`).
- [ ] Staff lists: by item (who has it), by attendee (scan QR → their open
      items, for a fast return), outstanding/overdue; CSV export.
- [ ] Inventory CRUD (`isAdmin`) + CSV import for the initial stock count.
- [ ] Email checkout/return receipts and "please return" reminders through
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

### B23. Participant hardware views
- [ ] `GET /api/hardware` (accepted attendees): inventory with availability,
      category filter, search. Never shows who has an item.
- [ ] `GET /api/hardware/mine`: my open + returned checkouts, due times.
- [ ] Optional: request/reserve an item for pickup (a queue staff see on the
      checkout screen). Neither old platform had this; build only if
      organizers want it.
- [ ] **Facilities:** an admin-editable list of on-site resources that aren't
      checked out (makerspaces, soldering, 3D printing, laser cutter, …;
      `hum-xii` had this as a static page), with location and access notes.
- **Depends on:** B22. **Related:** F20.

---

## Judging (merge HackUMass-Judging-New; replaces B11)

The judging platform was a separate Express 5 + EJS app with its own users
loaded from a CSV. Merge it into this API as a module under `/api/judging`
(judge endpoints) and `/api/admin/judging` (admin endpoints). Rewrite it to our
conventions (Express 4, CommonJS, named handlers, `routes → controllers →
schemas`, JSDoc), not copy it. Its EJS views become Next pages (F21). Build it
in this order; each subtask is its own PR.

**Bugs in the old judging code, to avoid in every subtask:**
- Logins came from `judges_auth.csv` with plaintext password comparison (B16),
  and `GET /auth/user` returned the logged-in judge's full CSV row,
  **password included**.
- No admin role: any judge could upload teams, regenerate assignments,
  recompute bias and view the leaderboard. Those destructive actions were
  `GET` links (`/generate_assignments`, `/update-bias-scores`, `/uploadTeams`,
  `/rejudge/:table`), so one malicious link could trigger them.
- Scoring accepted any values, didn't check the judge was assigned that
  table, allowed scoring the same team repeatedly, and crashed (request hangs)
  for an unknown table.
- Participants' table check-in link was `base64(team email)` and the table QR
  was `sha256("Table N")`; both are guessable, so anyone could check any team
  in.
- Timestamps used `moment(...).format('YYYY-MM-DD HH:MM:SS')` (`MM` is
  *month*), computed once at server start, so every record got the same wrong
  time.
- Room names hard-coded in `utils/helper.js`; Mongo URL + session config "DO
  NOT TOUCH"; 50 MB JSON body limit; unused `openai`, `ai` and SendGrid
  dependencies; `if (err) throw err` inside callbacks (crashes the process).

### B24a. Judge accounts (`judge` role)
- [ ] Add `judge` to the role enum. Admins invite judges (name, email,
      hardware-judge flag); the invite email uses the existing password-reset
      flow, so no passwords are ever handled by organizers.
- [ ] `utils/isJudge` guard (judges + admins).
- **Depends on:** B17 (role changes). **Related:** F21, T11.

### B24b. Teams / projects
- [ ] `schemas/team.js`: `name`, `members: [User]` (not `Mem1Name..Mem4Email`
      columns), `contactEmail`, `devpostUrl`, `categories: [String]`
      (tracks/prizes), `hardware: Boolean`, `needsPower: Boolean` (the old
      dashboard seated these near outlets), `room`, `table`,
      `tableCheckedIn`.
- [ ] Admin import from the Devpost CSV export: upload → server-side validation
      → preview diff → confirm. Match members to Users by email and report
      unmatched ones. Re-importing updates rather than duplicates.
- [ ] **Decision needed:** in-dashboard project submission (the old Rails app
      had it) vs. Devpost import only. Recommend Devpost import for this year.
- **Depends on:** B24a.

### B24c. Rooms, tables and team table check-in
- [ ] `schemas/judgingRoom.js` (`name`, `tableCount`, `hardware`), configured
      by admins instead of the hard-coded list.
- [ ] Desk check-in (old "checkin1"): staff scan a member's QR → assign the
      next free table in a transaction. Keep the old unique (room, table)
      index + retry approach, which was right. Hardware teams go to hardware
      rooms.
- [ ] Table check-in (old "checkin2"): a team member, logged in, scans the
      printed table QR. That QR holds a random per-table token (stored), not
      `sha256("Table N")`.
- [ ] Email each team its room/table via the mailer + a template (B26), not
      SendGrid.
- [ ] Printable output (the old `paper_judging` made PDFs): table signs with
      the table QR, and a paper rubric per team as a backup if Wi-Fi dies.
- **Depends on:** B24b.

### B24d. Judge calibration (tutorial rounds) + bias
- [ ] Port the tutorial flow: every judge scores the same practice projects.
- [ ] Move the bias calculation (`/update-bias-scores` in the old `server.js`)
      into `utils/judgingBias.js` as **pure functions**. Unit-test them
      against fixtures computed by hand (T11).
- [ ] `POST /api/admin/judging/bias` (admin), stored on the judge's profile
      with the time computed.
- **Depends on:** B24a.

### B24e. Assignment generation
- [ ] Port `utils/judging-assignments.js` (generator + verifier) into pure
      modules: given teams, judges, rooms and `judgesPerTeam`, return
      assignments, then verify them (every team judged k times, hardware
      teams only get hardware judges, balanced load). Run the verifier on
      every generated set and refuse to save one that fails.
- [ ] `POST /api/admin/judging/assignments` (admin) creates a new **version**.
      Regenerating never deletes scores already submitted.
- **Depends on:** B24b, B24c.

### B24f. Scoring
- [ ] Rubric configured per event (`criteria: [{ key, label, min, max,
      weight }]`), not `score1..score6`.
- [ ] `POST /api/judging/scores { teamId, scores, comments }` (`isJudge`):
      validate every criterion is an integer in range; the judge must be
      assigned that team; unique (judge, team) with **upsert**, so a rejudge
      replaces the score instead of adding one; unknown team → 404.
- [ ] Judge queue: `GET /api/judging/queue` (next team, progress, skipped);
      `POST /api/judging/skip` / unskip.
- **Depends on:** B24e.

### B24g. Results
- [ ] `GET /api/admin/judging/results`: per team and per category, raw and
      bias-adjusted averages, number of judges, and flags for teams with too
      few scores. Admin only; CSV export.
- [ ] Freeze switch: lock scoring once judging closes.
- **Depends on:** B24d, B24f.

### B24h. Prizes and winners
The old dashboard had prizes as data, not just Devpost text.
- [ ] `schemas/prize.js`: `name`, `sponsor`, `description`, `criteria`,
      `track` (the judging category it maps to), `quantity`, `winners: [Team]`.
- [ ] Admin CRUD; teams opt into prizes (from the Devpost import, or chosen in
      the dashboard if B24b adds submission).
- [ ] Assign winners from the results (B24g); publish the winners list.
- **Don't repeat:** the old `prizes` controller guarded `show`/`new`/`edit` but
  **not** `create`/`update`/`destroy`, so any logged-in user could change
  prizes by POSTing directly.
- **Depends on:** B24b, B24g.

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

### B39. Attendee travel reimbursements (deferred)
The 2018 `hackumass-web` branch `travel-reimbursements` let attendees file
travel claims with a receipt, grouped into travel groups (name, budget
amount, departure city); organizers toggled "approved", had "approve all", and
printed cost sheets. It was never merged.
- [ ] **Decision needed:** offer travel reimbursement this year? If yes, reuse
      the B36 pipeline: attendee submitters (their own requests only),
      a "Travel" budget line, caps per travel group or region, admin approve +
      pay.
- **Don't repeat:** `approved` was in the submitter's permitted form fields, so
  anyone could approve their own claim. `update`/`destroy` had no owner
  check. Money was a `float`.
- **Depends on:** B36.

---

## Registration gaps (found in the parity review)

### B40. Email verification on sign-up
The old dashboard confirmed emails (Devise `confirmable`); we don't, so anyone
can register with someone else's address, and their acceptance QR goes there.
- [ ] Send a verification link on register (token hashed in the DB, like the
      reset token; 24 h expiry); `POST /api/auth/verify-email`; resend
      endpoint (rate-limited).
- [ ] Applying requires a verified email. Google sign-ins count as verified.
- [ ] Existing users: treat as verified (or re-verify on next login: decide).
- **Depends on:** none.

### B41. Waitlist email and waitlist mode
- [ ] Deciding "waitlisted" currently sends **no email**: `DECISION_TEMPLATE_KEYS`
      in `adminController` only has accepted/rejected. Add a built-in
      `application_waitlisted` template and send it.
- [ ] Optional waitlist mode (the old dashboard had it): once a round reaches a
      configured number of accepted applicants, new applications are
      waitlisted automatically and told so.
- **Depends on:** none.

### B42. Flag suspicious applications
- [ ] `Application.flagged`, `flagReasons: [String]`, `flaggedBy`; moderators
      can flag/unflag with a reason; review list filter + count.
- [ ] Optional automatic checks on submit: resume text too short, resume
      doesn't mention the applicant's name, duplicate phone or resume across
      accounts.
- **Don't repeat:** the old auto-flag (`event_application.rb`) had a misplaced
  `!` in its university/major check, so it flagged the wrong applications.
  Write the rule as a small pure function with tests.
- **Depends on:** none.

### B43. Admin statistics
- [ ] `GET /api/admin/stats`: applications by status and round, by
      school/education level/gender/major/graduation year, first-time
      hackers, submissions per day; on event day, checked-in count, meals
      served, workshop attendance, hardware out.
- [ ] Aggregations in Mongo (`$group`), not loading every document.
- **Depends on:** none. **Related:** F26.

### B44. Force check-in (admin override)
- [ ] Admins can check in someone whose application isn't accepted (a walk-in
      approved at the desk), with a required reason, recorded on the CheckIn.
      The old dashboard had this, but as a client-side `force_check_in` flag
      anyone could send; ours must check `isAdmin` on the server.
- **Depends on:** check-in on `feature/qr-checkin`.

### B45. Public schedule feed for the hackathon website
- [ ] `GET /api/public/schedule` (no auth, cached): published run-of-show
      items + published workshops, so the hackathon website (e.g.
      `fuseumass/hackumass-website`) can show the live schedule instead of
      copying it. Also a public `.ics` of the same.
- **Depends on:** B18.

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
- [ ] `OrgSettings.branding`: `orgName`, `primaryColor`, `secondaryColor`,
      `accentColor?`, `logoUrl`, `logoDarkUrl`, `faviconUrl`. Validate colours
      as hex (`#RRGGBB`) and reject anything else; never pass raw CSS through.
- [ ] Defaults from **server** env (`BRAND_PRIMARY`, `BRAND_SECONDARY`, …) read
      at request time, so one image can serve every hackathon.
- [ ] Public `GET /api/meta/branding` (no auth, cacheable for ~60 s) returning
      branding + the public feature flags (B25). Logo upload via Azure.
- **Depends on:** none. **Related:** F12.

### B29. CSV exports
The old dashboard could export everything; organizers rely on it for
sponsors, catering and insurance.
- [ ] Admin CSV export for applications (with dynamic `answers` flattened),
      check-ins, meal counts, workshop sign-ups, raffle winners, hardware
      checkouts. Stream them; don't build the whole file in memory.
- [ ] Resume bundle export for sponsors (zip of accepted applicants who opted
      in), replacing the old `download_resumes.py` script.
- **Depends on:** none.

### B30. Dependency vulnerabilities
`npm audit` in `backend/` (Oct 2026): **critical** `proxy-addr` and
**moderate** `body-parser`/`qs` (via `express`), **high** `nodemailer`,
moderate `ip-address`, moderate `csv-parse` (fix is a major bump to v7).
- [ ] `npm audit fix` (non-breaking ones), run the test suite.
- [ ] `csv-parse` v7 upgrade: check `metaController`'s colleges loader still
      works.
- [ ] Add `npm audit --audit-level=high` to CI (T15).
- **Depends on:** none.

---

## Later / needs a decision

### B31. Mentorship tickets
The old dashboard had mentor tickets (attendee posts a request with a
screenshot, mentors claim and resolve). **Decision needed:** keep using
Discord for this, or build it? If built: `mentor` role, ticket CRUD, claim/
resolve, notify via Discord webhook. **Don't repeat:** the old
`mentorship_requests` controller guarded only `show` and `destroy`, so anyone
could edit anyone's ticket.

### B32. RSVP / confirm attendance after acceptance
The old dashboard had an RSVP step (plus custom RSVP questions, e.g. travel,
dietary) to get real headcounts before the event. Useful for catering and
reimbursements. Spec with organizers.

### B14. colleges.csv ingestion
Document/ship the real `Backend/data/colleges.csv` (organizer-provided) and make
the loader resilient to large files (streaming if needed).
- **Depends on:** none. **Related:** existing `metaController`.

### B15. Team/group applications (revisit)
The original `Team` schema is currently unused by the per-person application
flow. Decide whether team/group applications return, and if so wire them to the
new application model. Note B24b adds judging teams; decide whether these are
the same thing.
- **Depends on:** product decision. **Status:** deferred.
