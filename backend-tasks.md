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

---

## Check-in (event day)

### B7. Meal check-in endpoint - Richarla Preston @charlajp
Record a check-in per user per meal service (one row each, prevents double
serving). `POST /api/staff/meals/:mealId/checkin`, guarded by `isModerator`.
- **Depends on:** B6 (done). **Related:** F3, T3.

---

## Moderator data views (later — placeholders)

### B10. Hardware data endpoint (moderators)
Expose aggregated hardware info (from `hardwareSkills` and/or a future hardware
checkout model) at `/api/staff/hardware`, guarded by `isModerator`. Scope TBD by
organizers.
- **Depends on:** none. **Related:** F5. **Status:** deferred, needs spec.

### B11. Judging progress endpoint (moderators)
Endpoint(s) for judging progress once the judging model is defined.
- **Depends on:** a judging model (not yet designed). **Related:** F6.
  **Status:** deferred, needs spec.

---

## Supporting / hardening

### B14. colleges.csv ingestion
Document/ship the real `Backend/data/colleges.csv` (organizer-provided) and make
the loader resilient to large files (streaming if needed).
- **Depends on:** none. **Related:** existing `metaController`.

### B15. Team/group applications (revisit)
The original `Team` schema is currently unused by the per-person application
flow. Decide whether team/group applications return, and if so wire them to the
new application model.
- **Depends on:** product decision. **Status:** deferred.
