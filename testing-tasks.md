# Testing Tasks

Testing/QA backlog. Task IDs are `T#`. Cross-file links: `B#` = backend task,
`F#` = frontend task. See also [`backend-tasks.md`](./backend-tasks.md) and
[`frontend-tasks.md`](./frontend-tasks.md).

> **Workflow:** branch + pull request only — never commit to `main`. See the
> rule in [`README.md`](./README.md).

---

## T0. Verify what's already built (smoke + regression)
The features below are implemented but not yet formally tested. Write tests
and/or run manual QA:
- Register / login / `GET /api/auth/me`; JWT attaches on requests.
- Google OAuth end-to-end (needs real Google credentials) → `/auth/callback`
  stores token → dashboard.
- Forgot/reset password: token emailed (or logged when SMTP unset), reset works,
  token expires after 1 hour and is single-use.
- Roles + guards: `isAuthenticated` (401), `isModerator` (403 for applicants),
  `isAdmin` (403 for moderators).
- First-admin bootstrap: `SETUP_ADMIN=true` promotes by email, refuses once an
  admin exists, and is disabled when the env is `false`.
- Application submit + resume upload to Azure (needs real Azure connection
  string); one-application-per-round uniqueness; draft vs submit.
- Rounds: create/open/close, dates, only-open-round accepts submissions.
- Org settings: admin Google toggle actually hides the button (via
  `/api/meta/config`) and blocks `/api/auth/google`.
- User search + promote to moderator/admin; role change reflected in the sidebar.
- **Depends on:** the built features. **Related:** everything above.

## T1. Email notifications
Test template CRUD (B1), received email on submit (B2), decision emails (B3),
placeholder rendering (B4), and idempotency (no duplicate decision emails).
- **Depends on:** B1–B4, F1.

## T2. First check-in - Jeng-Aun Chou
Test the check-in endpoint + UI: moderators and admins can check in; applicants
cannot; double check-in is handled.
- **Depends on:** B5, F2.

## T3. Meal check-in
Test meal service CRUD (admin), per-user-per-meal uniqueness (no double
serving), and the staff check-in flow.
- **Depends on:** B6, B7, F3.

## T4. Per-round form builder
Test that admin-defined `formConfig` renders on the application page, dynamic
required fields validate, and answers persist. Moderators can't edit forms.
- **Depends on:** B8, B9, F4.

## T5. Security / hardening
Rate-limit behavior on auth endpoints (B13); authz coverage (no privilege
escalation via request body role); resume upload rejects oversized/wrong types.
- **Depends on:** B12, B13.

## T6. CI pipeline
GitHub Actions on every PR: `frontend` → `npm run lint` (Biome); `Backend` →
`node --check` over `**/*.js` (we don't type-check — see `README.md` §3). Wire
the test runners from T0–T5 as they land.
- **Depends on:** none. **Related:** the branch/PR rule in `README.md`.

## T7. Test harness setup
Choose and configure runners (e.g. a Node test runner + supertest for the API;
a component testing setup for the frontend), plus a seed/fixture strategy and a
disposable test database.
- **Depends on:** none. **Blocks:** T1–T5 automated coverage.
