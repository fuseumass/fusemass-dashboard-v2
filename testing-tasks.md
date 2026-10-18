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

### Conventions for new tests
- Concurrency guarantees ("never more than capacity", "never served twice")
  get a test that fires the requests **in parallel** with `Promise.all` and
  asserts the end state. Call `Model.init()` first so the unique indexes
  exist (see `resetFixtures` in `test/qrCheckin.test.js`).
- Every new route gets **401 (no token)** and **403 (wrong role)** cases. T12
  makes this systematic.
- Pure logic (bias, assignment generation, calendar building, raffle draws)
  lives in `utils/` and is unit-tested without HTTP or a database.
- Mail: use `helpers/mailMock` and assert on the recorded `sendMail` calls
  (subject, links, attachments, `icalEvent`), never a real SMTP server.

---

## T0. Manual QA that needs real credentials
The automated suite deliberately skips these; verify by hand before the event:
- Google OAuth end-to-end (real Google credentials) → `/auth/callback` stores
  token → dashboard.
- Application submit + resume upload to Azure (real Azure connection string).
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
      upload; non-signed-up user can't list posts or fetch files (per the B20
      decision); the file endpoint returns a short-lived URL, never a
      permanent one.
- [ ] **Attendance codes** (pure unit tests on the code function, with a fake
      clock): the code changes every period; the current and previous codes
      are accepted, the one before that isn't; different sessions give
      different codes.
- [ ] **Attendance API:** closed session or wrong code → rejected; parallel
      duplicate submissions → one row and both answer 200; a `userId` in the
      body is ignored; the rate limit and per-session lockout trip; staff add
      via QR works only for `canManageWorkshop`.
- [ ] **Raffle:** draws only ever pick attendees of *that* workshop (seed
      sign-ups who never attended and assert they're never drawn); `count`
      distinct winners; no repeat winners in the same workshop; a redraw
      excludes the no-show; the event-wide win cap holds; every draw is
      stored with its pool size.
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
- [ ] **Bias (pure unit tests):** hand-computed fixtures for 3 judges × 2
      tutorial rounds; a judge who scores everyone +2 gets a bias of +2 and is
      corrected in results; judges with no tutorial scores are left
      unadjusted (and flagged).
- [ ] **Assignments (property-style):** for random team/judge/room sets, the
      generator's output always passes the verifier: every team judged k
      times, hardware teams only get hardware judges, load within ±1 per
      judge. A deliberately broken assignment fails the verifier.
- [ ] **Scoring:** out-of-range / non-integer / missing criteria → 400; a judge
      scoring a team not assigned to them → 403; rejudge replaces the score
      (still one row per judge-team); unknown team → 404, not a hang; scoring
      after freeze → 409.
- [ ] **Table assignment:** 30 parallel desk check-ins → no two teams share a
      (room, table); hardware teams land in hardware rooms; the table QR from
      another table is rejected.
- [ ] **Permissions:** judges get 403 on every `/api/admin/judging/*` route;
      none of those routes accept `GET` for changes.
- **Depends on:** B24a–B24g.

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
      (other lines → 403) and sees only their teams' detail; demoting a member
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
- [ ] One table-driven test file: for **every** mounted route (method + path)
      and every role (`none`, `applicant`, `workshop_organizer`, `judge`,
      `moderator`, `admin`), the expected status class (2xx/4xx/401/403).
- [ ] A guard test that walks Express's router stack and **fails when a route
      exists that isn't in the matrix**, so new routes can't skip review.
- **Depends on:** B17 (new roles); extend as modules land.

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
- [ ] Secret scanning on every PR (e.g. `gitleaks`), failing on hits; also
      block committing `*.csv` exports outside `backend/data/`.
- [ ] `npm audit --audit-level=high` for backend and frontend (B30).
- [ ] Assert that no route responds with `passwordHash`, `resetPasswordToken`,
      or another user's `qrId` (extend the existing `securityHardening`
      tests).
- **Depends on:** none.
