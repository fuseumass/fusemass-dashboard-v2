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

---

## T0. Manual QA that needs real credentials
The automated suite deliberately skips these; verify by hand before the event:
- Google OAuth end-to-end (real Google credentials) → `/auth/callback` stores
  token → dashboard.
- Application submit + resume upload to Azure (real Azure connection string).
- **Depends on:** the built features.

## T2. First check-in - Jeng-Aun Chou
Test the check-in endpoint + UI: moderators and admins can check in; applicants
cannot; double check-in is handled.
- **Depends on:** B5 (done), F2.

## T3. Meal check-in
Admin meal CRUD is already covered (`backend/test/admin-meals-crud.test.js`).
Still to test: per-user-per-meal uniqueness (no double serving) and the staff
check-in flow.
- **Depends on:** B6 (done), B7, F3.

## T7. Frontend test setup
The backend harness is done (see above). Still to do: a component testing setup
for the frontend, wired into CI.
- **Depends on:** none.
