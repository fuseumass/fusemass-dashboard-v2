# Testing Tasks

Testing/QA backlog. Task IDs are `T#`. Cross-file links: `B#` = backend task,
`F#` = frontend task. See also [`backend-tasks.md`](./backend-tasks.md) and
[`frontend-tasks.md`](./frontend-tasks.md).

> **Workflow:** branch + pull request only — never commit to `main`. See the
> rule in [`README.md`](./README.md).

Already covered (not tasks here): the backend test suite in `backend/test/`
(`node:test` + supertest, disposable database per file via `test/helpers/`; run
with `cd backend && npm test`) covering auth + JWT + role guards, first-admin
bootstrap, password reset, rounds/org settings/user management, email templates
+ notifications, the per-round form builder, rate limiting + security hardening,
and meal service admin CRUD. CI (GitHub Actions) runs frontend lint, backend
`node --check`, and the backend tests on every PR.

**In review on `feature/qr-checkin`:** `test/qrCheckin.test.js` and
`test/checkedInEmail.test.js` cover T2 and T3 below, plus the QR emails, the
checked-in email + calendar invite, and run-of-show CRUD.

**On `feature/testing-backlog`:** `test/permissionMatrix.test.js` (T12: the
role x route matrix and the guard that fails on unlisted routes),
`test/sensitiveFields.test.js` (T15: no secrets in any response), and the
secret-scanning + CSV job in CI (T15). They found and fixed a real leak: user
JSON included each user's check-in code (`qrId`).

### Conventions for new tests
- Concurrency guarantees ("never more than capacity", "never served twice")
  get a test that fires the requests **in parallel** with `Promise.all` and
  asserts the end state. Call `Model.init()` first so the unique indexes
  exist (see `resetFixtures` in `test/qrCheckin.test.js`).
- Every new route gets **401 (no token)** and **403 (wrong role)** cases. T12
  makes this systematic: **add a row for every new route to the `MATRIX` in
  `test/permissionMatrix.test.js`** (the suite fails until you do), choosing
  its access level (`public` / `authenticated` / `moderator` / `admin`).
- Pure logic (bias, assignment generation, calendar building, raffle draws)
  lives in `utils/` and is unit-tested without HTTP or a database.
- Mail: use `helpers/mailMock` and assert on the recorded `sendMail` calls
  (subject, links, attachments, `icalEvent`), never a real SMTP server.

---

## T0. Manual QA that needs real credentials
The automated suite deliberately skips these; verify by hand before the event:
- Google OAuth end-to-end (real Google credentials) → `/auth/callback` stores
  token → dashboard.
- Application submit + resume upload to Azure (real Azure connection string),
  then "View resume" as the applicant and as a moderator opens the file, and
  the bare blob URL (without the signed query string) is refused.
- **Add:** real-device QR scanning on iOS Safari + Android Chrome over HTTPS
  (camera permission prompt, back camera, low light, cracked screens), and a
  USB handheld scanner in the code box.
- **Add:** open the acceptance email (QR image) and the checked-in email
  (calendar invite → "Add to calendar") in Gmail web, Gmail iOS, Outlook and
  Apple Mail.
- **Depends on:** the built features.

## T2. First check-in - Jeng-Aun Chou
Test the check-in endpoint + UI: moderators and admins can check in; applicants
cannot; double check-in is handled.
- **Status:** backend covered on `feature/qr-checkin`. UI test pending T7.
- **Depends on:** B5 (done), F2.

## T3. Meal check-in
Admin meal CRUD is already covered (`backend/test/admin-meals-crud.test.js`).
Still to test: per-user-per-meal uniqueness (no double serving) and the staff
check-in flow.
- **Status:** backend covered on `feature/qr-checkin` (including 3 parallel
  scans → exactly one served). UI test pending T7.
- **Depends on:** B6 (done), B7, F3.

## T7. Frontend test setup
The backend harness is done (see above). Still to do: a component testing setup
for the frontend, wired into CI.
- [ ] Vitest + React Testing Library + `jsdom` (plain JS config, no TS), run in
      CI next to `npm run lint`.
- [ ] Mock `apiFetch` at the module boundary; one test per page for its
      loading / empty / error / success states (the states F15 requires).
- [ ] Start with the shared pieces everything uses: `CheckInStation`
      (success / duplicate / error banners), the `DataTable` wrapper, form
      validation messages.
- **Depends on:** none (better after F10).

## T9. Workshops
- [ ] **Capacity under concurrency:** capacity 5, 20 parallel sign-ups →
      exactly 5 succeed and `signupCount === 5`; cancel one → one more can
      join; with a waitlist, the first waiter is promoted.
- [ ] Sign-up acts only on `req.user` (a `userId` in the body is ignored);
      applicants who aren't accepted get 403; duplicate sign-up → 409 without
      bumping the counter.
- [ ] **Organizer scoping:** organizer of workshop A gets 403 posting to,
      reading sign-ups of, or drawing the raffle for workshop B; their
      workshop list contains only A; they get 403 on `/api/admin/*` and
      `/api/staff/*`.
- [ ] **Announcements:** wrong file type / oversized file → 400 before any
      upload; any accepted attendee can list posts and fetch files, signed up
      or not, while non-accepted users and other roles' outsiders get 403;
      unpublished workshops are hidden; the file endpoint returns a
      short-lived URL, never a permanent one.
- [ ] **Attendance codes** (pure unit tests on the code function, with a fake
      clock): the code changes every period; the current and previous codes
      are accepted, the one before that isn't; different sessions give
      different codes.
- [ ] **Event check-in required:** an accepted attendee who isn't checked in
      to the event gets 403 with the right code (by code and via staff add),
      and is never in a raffle pool; once checked in, the same request
      succeeds.
- [ ] **Attendance API:** closed session or wrong code → rejected; parallel
      duplicate submissions → one row and both answer 200; a `userId` in the
      body is ignored; the rate limit and per-session lockout trip; staff add
      via QR works only for `canManageWorkshop`.
- [ ] **Raffle:** draws only ever pick attendees of *that* workshop (seed
      sign-ups who never attended and assert they're never drawn); `count`
      distinct winners; no repeat winners in the same workshop; a redraw
      excludes the no-show; the event-wide win cap holds; every draw is
      stored with its pool size.
- [ ] **Raffle timing and email:** drawing before `endsAt` → 409 unless the
      organizer used the end-early override; a signed-up attendee who never
      entered the code is never drawn; the winner email (mail mock) names the
      prize, the workshop and the configured organizer room + location.
- [ ] **Assigned staff:** a moderator listed in `organizers` can manage that
      workshop and gets 403 on another; a judge can't be assigned.
- [ ] **Calendar invites:** sign-up email has an `icalEvent` with a stable UID;
      a time change re-sends with `SEQUENCE` + 1; cancelling sends
      `METHOD:CANCEL` with the same UID.
- **Depends on:** B17–B21.

## T10. Hardware
- [ ] **Stock under concurrency:** an item with 1 left, 5 parallel checkouts →
      exactly 1 succeeds and `availableQty` ends at 0, never negative.
- [ ] A failed checkout after stock was taken puts it back (simulate a failure
      in the checkout insert).
- [ ] Return is idempotent: returning twice adds stock back once.
- [ ] `maxPerAttendee` enforced; attendee not event-checked-in → 400;
      applicant role → 403 on every staff hardware route (the old dashboard
      had no guard here at all).
- [ ] Participant endpoints never expose who holds an item; `/mine` returns
      only the caller's checkouts.
- **Depends on:** B22, B23.

## T11. Judging (merged platform)
Write the algorithm tests **before** changing the ported code (B24a): they
pin down what the 2025 code does, then catch regressions when its bugs are
fixed.
- [x] **Characterization (assignments):** with a seeded RNG, run the ported
      generator on the 2025 shape (regular rooms 33/49/33/40/22, hardware room
      31, ~160 projects, 3 judgings each) and on small shapes. Assert the
      invariants: every project judged exactly k times; no judge sees a
      project twice; no two judges at one table in the same slot; no two
      judges start at the same table; load within ±2; hardware projects only
      get hardware judges (separate pools).
- [x] **Verifier fix:** a hand-built case where the 2025
      `_fixUnderJudgedProjects` creates a slot clash. The old verifier reports
      success; the fixed one re-runs every check and fails (or places it
      correctly).
- [x] **Bias (pure):** a fixture of 3 judges × 3 calibration rounds computed by
      hand with the 2025 formula (judge's mean of the general criteria minus
      the mean of all judges' means, per round, averaged; category the same);
      a judge who scores everything +2 gets general bias +2; a judge with no
      calibration gets `null`.
- [x] **Calibration API (B24d):** rubric validation, ordered round upserts, completion,
      bias compared with the pure formula over completed judges only, configuration
      reset/locking, role permissions and feature gates in `judgingCalibration.test.js`.
      Written but not executed in the offline environment without MongoDB.
- [x] **Results (pure):** the bias-adjusted ranking flips the order of two
      projects where a strict judge saw one and a generous judge the other;
      projects with fewer than k scores are flagged.
      Written in `backend/test/judgingResults.test.js`: hand calculations, weighted
      averages, ties, missing calibration, empty/withdrawn projects, active-version
      progress, retained scores, role permissions, feature gates and formula-safe
      CSV content. Tests not run here as requested (no MongoDB).
- [x] **Devpost import:** a fixture CSV with the real repeated `TeamMem1*`
      headers keeps all 4 members with full names (2025 kept one first name);
      an empty hardware column doesn't crash; re-import updates instead of
      duplicating; unmatched emails are reported.
- [x] **Desk + table check-in:** 20 parallel desk check-ins → unique, continuous
      table numbers across rooms in order; hardware projects go to the
      hardware room; room full → clear error; table check-in with another
      table's token → "wrong table" naming the right one; table check-in
      before desk → rejected; idempotency, project selection, bulk confirmation, undo, email queueing and permissions covered in `backend/test/judgingCheckin.test.js`. Written, not run here (no MongoDB). Assignment eligibility remains B24e.
- [x] **Scoring:** out-of-range / non-integer / missing criteria → 400; a
      project not in the caller's queue → 403; rescoring is an upsert (one
      row per judge and project); **scoring a skipped project doesn't advance
      the queue** (2025 bug); unknown project → 404, not a hang; after freeze →
      409; the assignment sheet includes the first project.
- [x] **Versions:** activating a regenerated version keeps existing scores;
      removing a judge takes them out of the active queues.
      Written in `backend/test/judgingScoring.test.js`, including hardware pools, vacancies, verifier failures, late changes, withdrawal, freeze, rubric validation and feature gates. New routes are in the permission matrix. Not run here: no MongoDB.
- **Depends on:** B24a–B24h, B47.

## T16. Finance
- [ ] **Money is cents:** amounts are stored and summed as integers; `12.10 +
      0.20` style inputs never produce float drift; non-integer cents or
      negative amounts → 400.
- [ ] **Totals:** for a seeded budget (lines across 2 teams; open, closed,
      submitted, approved, paid, rejected and voided expenses), the summary
      gives exact allocated / committed / spent / remaining per line, team and
      budget; rejected and voided count nowhere.
- [ ] **State machine:** every allowed transition works and every other one is
      a 409 (e.g. `paid` → `approved`, closing a `personal` expense, approving
      a withdrawn request); each transition appends to history.
- [ ] **Separation of duties:** an admin can't approve or pay their own
      request; another admin can; a single-admin deployment gets the
      explanatory error.
- [ ] **Scoping:** a moderator can add expenses only to their teams' lines
      (other lines → 403); their summary contains only their teams (no other
      teams' totals, no budget-wide total, no income), and asking for another
      team's summary → 403; demoting a member
      to applicant removes finance access immediately; applicants, judges and
      workshop organizers get 403 on every finance route.
- [ ] **Locking:** a locked budget rejects every write under it.
- [ ] **Receipts:** a personal expense without a receipt → 400; another team's
      moderator can't fetch a receipt; the download is a short-lived URL.
- [ ] **Owed view:** approved-unpaid total and per-person amounts match the
      seeded data; a batch "mark paid" updates all of them with one reference
      and sends one email each (mail mock).
- **Depends on:** B33–B37.

## T12. Role × route permission matrix
Missing permission checks were the most common bug in both old platforms
(hardware checkout, RSVPs, prizes, mentorship tickets, travel-reimbursement
approval, every judging admin action). Finance makes this matter more.
- [x] One table-driven test file: for **every** mounted route (method + path)
      and every role, the expected status. Done in
      `test/permissionMatrix.test.js` for the roles that exist today (`none`,
      `applicant`, `moderator`, `admin`): 401 / 403 where denied, "let
      through" where allowed, plus a pass with valid bodies and real ids
      proving a denied request changes nothing and sends no email, and tokens
      that claim a role the account doesn't have.
- [ ] **Add the new roles to that file** when B17 / B47 land: add
      `workshop_organizer` and `judge` to `ROLES` and `LEVELS`. Judges in
      particular: 2xx only on `/api/judging/*` and `/api/auth/*`; 403 on
      applications, the attendee QR, staff, admin, workshops and finance.
- [x] A guard test that walks Express's router stack (`test/helpers/routes.js`)
      and **fails when a route exists that isn't in the matrix** (or the matrix
      lists one that no longer exists), so new routes can't skip review.
- **Depends on:** B17, B47 (new roles); extend as modules land.

## T13. End-to-end event-day flow (Playwright)
- [ ] Seeded run: apply → admin accepts → (mail mock) acceptance has a QR →
      staff scans it at check-in → checked-in email has the run of show →
      meal scan → workshop sign-up + raffle code → hardware checkout + return
      → judge scores the team.
- [ ] Run against `next build && next start` + the API + a disposable Mongo in
      CI (nightly, not on every PR, if it's slow).
- **Depends on:** T7, and the modules it covers.

## T14. Theming
- [ ] Unit: the contrast helper picks a readable foreground for a range of
      colours (white on `#4f46e5`, black on `#facc15`); invalid hex is
      rejected by the API (B28).
- [ ] Integration: change branding via the admin API → a page render reflects
      the new `--primary`/`--secondary` without a rebuild (the F12 bug).
- [ ] Visual: screenshot the button/badge/sidebar preview set in light + dark
      (Playwright screenshots, reviewed in the PR).
- **Depends on:** B28, F12.

## T15. Security checks in CI
Prompted by the judging repo committing judge passwords and participant data
(B16).
- [x] Secret scanning on every PR (`gitleaks`, pinned + checksum-verified,
      scans the PR's commits), failing on hits; also blocks committing `*.csv`
      exports outside `backend/data/`. The `secrets + exports` job in
      `.github/workflows/ci.yml`; add it to the required checks on `main`.
- [ ] `npm audit --audit-level=high` for backend and frontend (B30).
      **Blocked on B30:** both lockfiles currently have high or critical
      advisories (backend: `proxy-addr` critical, `nodemailer` high; frontend:
      3 high + 1 critical), so the step would turn every PR red until they're
      fixed.
- [x] Assert that no route responds with `passwordHash`, `resetPasswordToken`,
      or another user's `qrId`. Done in `test/sensitiveFields.test.js` (next
      to `securityHardening`): it crawls every GET route as nobody, an
      applicant, a moderator and an admin, and runs the flows that return
      users or touch a secret (register, login, reset, role change,
      setup-admin, check-in, teams), scanning each response for the forbidden
      keys and for the secret values. It caught `qrId` leaking through admin
      user search, role changes and setup-admin (fixed in `schemas/user.js`).
- **Depends on:** none.

### Judging teams regression coverage
- [x] Write `backend/test/judgingTeams.test.js`: team combination, URL/email matching, duplicate-team errors, cross-team warnings, preserved links and unique admin overrides.
- [x] Cover lock-before-table-write, self-service 423 paths, readable locked teams, undo/unlock, bulk locking, staff locked-team actions, capacity, project synchronization and audit actors.
- [x] Cover participant sheet pool separation, current-location counts, own-team completion, stable anonymous labels, identity exclusion, closed response and judge denial.
- [x] Add every new route to the permission matrix; adapt existing import/allocation mocks.
- [ ] Run backend tests with MongoDB. Not attempted in this offline environment, as requested.
- [ ] Browser screenshots, keyboard and physical scanner checks.
