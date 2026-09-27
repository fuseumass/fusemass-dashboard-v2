# Frontend Tasks

Backlog for the Next.js 16 app. Task IDs are `F#`. Cross-file links: `B#` = a
backend task, `T#` = a testing task. See also
[`backend-tasks.md`](./backend-tasks.md) and [`testing-tasks.md`](./testing-tasks.md).

> **Workflow:** branch + pull request only — never commit to `main`. See the
> rule in [`README.md`](./README.md).

Already built **and** ready to test (not tasks here — see `testing-tasks.md`):
login/signup/forgot-password/reset-password pages, the "Sign in with Google"
button (auto-hides when disabled), the OAuth callback page, the white-label
config (`NEXT_PUBLIC_ORG_NAME` / `LOGO` / `LOGO_V2` / `BRAND_COLOR`), the
TreeHacks-style dashboard sidebar (role-aware), the full application form
(university + skills autocomplete, resume upload, socials, experience), the
applicant home, and the admin **Review**, **Users** (search + promote), and
**Settings** (Google toggle, rounds + dates, per-round form JSON) pages.

---

## Design / branding polish

### F0. Visual design pass on auth + dashboard
The current UI is functional with a small design-system layer (`globals.css`).
Apply the real brand design (typography scale, spacing, empty states, mobile
sidebar drawer). Keep existing logic/handlers intact.
- **Depends on:** none. **Related:** all pages.

### F0b. Responsive + accessibility pass
Mobile layout for the sidebar (collapsible), keyboard nav, ARIA, contrast.
- **Depends on:** none.

---

## Email templates

### F1. Admin email-template editor - Jeffrey Deng
Settings sub-page (admins only) to edit the subject/body of the
`application_received` / `accepted` / `rejected` emails, with a list of
available `{{placeholders}}` and a preview.
- **Depends on:** B1 (template CRUD). **Related:** T1.

---

## Check-in (event day)

### F2. First check-in UI (moderators + admins) - Jeng-Aun Chou
A staff page to look up an accepted applicant (search by name/email) and mark
them checked in; show who/when. Visible to moderators and admins.
- **Depends on:** B5. **Related:** T2.

### F3. Meal check-in UI + admin meal setup - Richarla Preston @charlajp
Admin: create/manage meal services (name, time window). Staff (mod+admin):
select the active meal and check attendees in, with a guard against double
serving.
- **Depends on:** B6, B7. **Related:** T3.

---

## Application form builder (per round)

### F4. Round form builder + dynamic application rendering - Jeffrey Deng
Replace the raw JSON `formConfig` textarea in Settings with a real builder
(add/reorder/remove fields, pick type, mark required). Then have the applicant
application page render the round's dynamic fields alongside the standard ones.
- **Depends on:** B8, B9. **Related:** T4. **Note:** admins only (not moderators).

---

## Moderator data views (later — placeholders)

### F5. Hardware data view (moderators)
Page for moderators to view hardware data once B10 lands.
- **Depends on:** B10. **Status:** deferred, needs spec.

### F6. Judging progress view (moderators)
Page for judging progress once B11 lands.
- **Depends on:** B11. **Status:** deferred, needs spec.

---

## Supporting

### F7. Client-side form validation + friendlier errors - Richarla Preston @charlajp
Field-level validation on the application and auth forms (email format, phone,
required), inline error messages.
- **Depends on:** none.

### F8. Session/token expiry handling - @mli721
Detect expired tokens app-wide and redirect to `/login` with a message
(currently handled per-page in the dashboard layout).
- **Depends on:** none.

### F9. Logo assets
Drop real `public/logo.png` and `public/logo-v2.png`, set the
`NEXT_PUBLIC_*` env vars per deployment. The `Logo` component already falls back
to the org name text until then.
- **Depends on:** none.
