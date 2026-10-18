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

Most of the new tasks port features from the two platforms we used before,
fixing their bugs on the way. Each task has a **Don't repeat** list of the bugs
found in the old code.

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
- [ ] Bulk email to a segment (accepted / checked in / workshop sign-ups /
      people still holding hardware). This replaces the old dashboard's
      mass-email and Slack-blast features.
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

### B21. Workshop raffle codes
At the workshop the organizer shows a code on screen; attendees in the room
enter it on the dashboard to get a raffle entry; the organizer draws a winner.
- [ ] Organizer generates a code: `POST /api/workshops/:id/raffle/code`
      (`canManageWorkshop`). Make it 6 characters from an unambiguous alphabet
      (no 0/O/1/I), random via `crypto.randomInt`, valid for a configurable
      window (default 15 min), regenerable (the old code stops working).
- [ ] Attendee enters it: `POST /api/workshops/:id/raffle/enter { code }`. One
      entry per user per workshop (unique index), only while the code is
      live. **Decision needed:** require being signed up and/or event
      checked-in? Recommend requiring event check-in only.
- [ ] Rate-limit attempts per user + IP (e.g. 10/min). Six characters from 30
      symbols is ~730M codes, but only with a limiter.
- [ ] `GET /api/workshops/:id/raffle/entries` (organizer: count + list).
- [ ] `POST /api/workshops/:id/raffle/draw { count }`: pick winners with
      `crypto.randomInt`, excluding previous winners of the same workshop.
      Store each draw (who, when, winners) for audit; email winners via B26.
- [ ] An admin view across workshops, so one person can't win every raffle
      (configurable: max wins per attendee).
- **Don't repeat:** don't reuse the old `redeem_code` pattern (B17). A raffle
  code only ever creates a raffle entry.
- **Depends on:** B18, B19. **Related:** F17, F18, T9.

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
      (tracks/prizes), `hardware: Boolean`, `room`, `table`, `tableCheckedIn`.
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
