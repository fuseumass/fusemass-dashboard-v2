# Backend Tasks

Backlog for the Express 4 + Mongoose API. Task IDs are `B#`. Cross-file links:
`F#` = a frontend task, `T#` = a testing task. See also
[`frontend-tasks.md`](./frontend-tasks.md) and [`testing-tasks.md`](./testing-tasks.md).

> **Workflow:** branch + pull request only — never commit to `main`. See the
> rule in [`README.md`](./README.md).

Already built **and** ready to test (so they are not tasks here — they live in
`testing-tasks.md`): email/password auth + JWT, Google OAuth, password reset
(nodemailer), the `applicant`/`moderator`/`admin` roles + `isAuthenticated` /
`isModerator` / `isAdmin` guards, the standard application + resume→Azure upload,
application rounds (create/open/close/dates/formConfig), org settings + Google
toggle, first-admin bootstrap (`SETUP_ADMIN`), user search + promote, and the
colleges/skills autocomplete endpoints.

---

## Email notifications (editable templates)

### B1. Email template storage + CRUD - Jeffrey Deng
Add an `EmailTemplate` schema (key, subject, body with placeholders like
`{{name}}`, `{{status}}`) and admin-only CRUD routes under `/api/admin/email-templates`.
Seed defaults for `application_received`, `application_accepted`,
`application_rejected`.
- **Depends on:** none. **Related:** F1 (editor UI), T1.

### B2. Send "application received" email on submit - Jeffrey Deng
When an application is submitted (status → `pending` in `applicationController.apply`),
render the `application_received` template and send via `utils/mailer`.
- **Depends on:** B1. **Related:** T1.

### B3. Send decision email on accept/reject - Jeffrey Deng
When `decideApplication` sets `accepted`/`rejected`, send the matching template.
Make it idempotent (don't re-send if status is unchanged).
- **Depends on:** B1. **Related:** F1, T1.

### B4. Template rendering helper - Jeffrey Deng
Small `utils/renderTemplate.js` that substitutes `{{placeholders}}` safely
(escape, handle missing values). Used by B2/B3.
- **Depends on:** none. **Related:** B2, B3, T1.

---

## Check-in (event day)

### B5. First check-in model + endpoint - Jeng-Aun Chou
Add check-in fields (e.g. `checkedInAt`, `checkedInBy`) — on the `User` or a
dedicated `CheckIn` record keyed to an accepted application. Endpoint
`POST /api/staff/checkin` (mark) and `GET /api/staff/checkin/:userId` (status),
guarded by `isModerator` (moderators **and** admins).
- **Depends on:** none (uses existing roles). **Related:** F2, T2.

### B6. Meal service setup (admin) - Noah
Add a `MealService` schema (name e.g. "Saturday Lunch", startsAt, endsAt,
active). Admin-only CRUD under `/api/admin/meals`.
- **Depends on:** none. **Related:** F3, T3.

### B7. Meal check-in endpoint
Record a check-in per user per meal service (one row each, prevents double
serving). `POST /api/staff/meals/:mealId/checkin`, guarded by `isModerator`.
- **Depends on:** B6. **Related:** F3, T3.

---

## Application form builder (per round)

### B8. Respect per-round `formConfig` on submit - Jeffrey Deng
`applicationRound.formConfig` already exists. Make `applicationController.apply`
validate/accept the dynamic fields defined by the round's config (required
fields, allowed options) instead of only the fixed schema fields. Store dynamic
answers in a flexible `answers` map on the application.
- **Depends on:** none (schema field exists). **Related:** F4, T4.

### B9. Form-config validation - Jeffrey Deng
Validate the `formConfig` payload shape on `PATCH /api/admin/rounds/:id`
(each field has key/label/type/required; types from an allowed set).
- **Depends on:** none. **Related:** F4, T4.

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

### B12. Input validation layer - Jeffrey Deng
Centralize request validation (a small middleware or helper) instead of ad-hoc
checks in each controller.
- **Depends on:** none. **Related:** all controllers.

### B13. Rate-limit auth endpoints - Jeffrey Deng
Add rate limiting to `/api/auth/login`, `/register`, `/forgot-password`,
`/setup-admin` to slow brute force.
- **Depends on:** none. **Related:** T5.

### B14. colleges.csv ingestion
Document/ship the real `Backend/data/colleges.csv` (organizer-provided) and make
the loader resilient to large files (streaming if needed).
- **Depends on:** none. **Related:** existing `metaController`.

### B15. Team/group applications (revisit)
The original `Team` schema is currently unused by the per-person application
flow. Decide whether team/group applications return, and if so wire them to the
new application model.
- **Depends on:** product decision. **Status:** deferred.
