# Frontend Tasks

Backlog for the Next.js 16 app. Task IDs are `F#`. Cross-file links: `B#` = a
backend task, `T#` = a testing task. See also
[`backend-tasks.md`](./backend-tasks.md) and [`testing-tasks.md`](./testing-tasks.md).

> **Workflow:** branch + pull request only — never commit to `main`. See the
> rule in [`README.md`](./README.md).

Already built (not tasks here): login/signup/forgot-password/reset-password
pages with client-side validation, the "Sign in with Google" button (auto-hides
when disabled), the OAuth callback page, the white-label config
(`NEXT_PUBLIC_ORG_NAME` / `LOGO` / `LOGO_V2` / `BRAND_COLOR`), the
TreeHacks-style dashboard sidebar (role-aware), app-wide session-expiry handling
(redirect to `/login?expired=1`), the full application form (university + skills
autocomplete, resume upload, socials, experience, plus the round's dynamic
fields), the applicant home, and the admin **Review**, **Users** (search +
promote), and **Settings** (Google toggle, rounds + dates, per-round form
builder, email-template editor) pages.

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

## Check-in (event day)

### F2. First check-in UI (moderators + admins) - Jeng-Aun Chou
A staff page to look up an accepted applicant (search by name/email) and mark
them checked in; show who/when. Visible to moderators and admins.
- **Depends on:** B5 (done). **Related:** T2.

### F3. Meal check-in UI + admin meal setup - Richarla Preston @charlajp
Admin: create/manage meal services (name, time window). Staff (mod+admin):
select the active meal and check attendees in, with a guard against double
serving.
- **Depends on:** B6 (done), B7. **Related:** T3.

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

### F9. Logo assets - Richarla Preston @charlajp
Drop real `public/logo.png` and `public/logo-v2.png`, set the
`NEXT_PUBLIC_*` env vars per deployment. The `Logo` component already falls back
to the org name text until then.
- **Depends on:** none.
