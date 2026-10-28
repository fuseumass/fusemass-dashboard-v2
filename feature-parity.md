# Feature parity with the old platforms

Every feature the previous HackUMass tools had, whether this dashboard has it,
and the task that covers it. **Keep this file updated** when a task lands or a
feature is dropped on purpose, so nothing silently goes missing again.

Task IDs link to [`backend-tasks.md`](./backend-tasks.md) (`B#`),
[`frontend-tasks.md`](./frontend-tasks.md) (`F#`) and
[`testing-tasks.md`](./testing-tasks.md) (`T#`).

**Status:** ✅ built · 🔍 in review (`feature/qr-checkin`) · 🟡 partial ·
📋 tasked · ⏸ deferred / needs a decision · ✖ dropped on purpose · ➕ new
(the old tools never had it).

## Sources reviewed (Oct 2026)

| Platform | Repo | Stack | Notes |
| -------- | ---- | ----- | ----- |
| Old dashboard | [fuseumass/dashboard](https://github.com/fuseumass/dashboard) | Rails | `master` (2023) is the full feature set. Event branches (`hum-xii`, `hackher2025`, …) only add content tweaks plus a Facilities page. |
| Older dashboard | `fuseumass/hackumass-web` (private) | Rails | 2018 predecessor. Its `travel-reimbursements` branch is the **only finance code that ever existed**; it was never merged. |
| Judging | [gamer-1478/HackUMass-Judging-New](https://github.com/gamer-1478/HackUMass-Judging-New) | Express 5 + EJS | Used Nov 2025. See B16 (leaked credentials) and B24. |
| Sponsorship CRM | [fuseumass/hackerforce](https://github.com/fuseumass/hackerforce) | Django | Companies, contacts, sponsorship tiers/perks/contributions, email campaigns. **Not being merged** (decided Oct 2026). |

No repo had **budgets, team expenses or organizer reimbursements**. Those
were presumably tracked in spreadsheets, so B33–B37 are a new design.

## Accounts & roles

| Old feature | Status | Task |
| ----------- | ------ | ---- |
| Email/password sign-up, login, forgot password | ✅ | — |
| Email confirmation on sign-up (Devise `confirmable`) | ✅ link on register, resend, required to apply (existing users count as verified) | B40 |
| Google sign-in | ➕ ✅ | — |
| Roles: admin / organizer / attendee | ✅ as admin / moderator / applicant | — |
| Mentor role | ✖ mentorship runs on Discord | B31 |
| Judge role (judging app used a CSV of logins) | 📋 | B47 |
| Workshop organizer role | ➕ 📋 | B17 |
| Admin role management (`pages#permissions`) | ✅ Users page | — |
| "Redeem code" to upgrade your own role | ✖ security hole (let anyone become admin) | B17 |
| Slack: join gate, DMs, account re-association | ✖ replaced by Discord link + email | B26 |
| Marketing-email consent (`non_transactional_email_consent`) | 🟡 backend done (off by default, sign-up/profile field, unsubscribe link, enforced for announcements); sign-up checkbox + profile toggle are UI follow-ups | B26 |
| Failed-email page (`/check-failed-emails` in the judging app) | ➕ ✅ email outbox: log, backoff retries, resend, `/dashboard/admin/outbox` | B26 |

## Registration & review

| Old feature | Status | Task |
| ----------- | ------ | ---- |
| Application form + resume upload | ✅ private storage, 5-min signed view links | — |
| Custom questions from YAML config | ✅ per-round `formConfig`, incl. resume upload questions | — |
| University / major autocomplete | 🟡 university + skills; majors are free text | F14 |
| Application mode open / closed | ✅ rounds open/close | — |
| Waitlist mode (auto-waitlist past capacity) | ✅ per-round `waitlistAfterAccepted`; first submissions past it are waitlisted and emailed | B41 |
| Accept / deny / waitlist decisions | ✅ | — |
| Accepted / denied emails | ✅ | — |
| **Waitlisted email** | ✅ built-in `application_waitlisted` template | B41 |
| Accepted status still visible after applications close | ✅ `latest` on `GET /api/applications/me`, shown on the home page | B27, F22 |
| Application search | 🟡 status/round filters only | F14 |
| Resume auto-check + flag suspicious applications, flag/unflag | 🟡 flag/unflag, list filter + count, optional auto-checks (short resume, name missing, duplicate phone/resume). Resume text is read for Word files and plain-text PDFs only; other PDFs skip the text rules | B42 |
| Admin statistics (counts by school, gender, status, …) | 🟡 built; workshop attendance + hardware out wait on B21/B22 | B43, F26 |
| CSV export of applications | ✅ admin only, answers flattened, formula-safe | B29 |
| RSVP + custom RSVP questions + un-RSVP | ⏸ | B32 |
| Mass email to lists (not applied / accepted / waitlisted / undecided / test to self) | 🟡 API done (`POST /api/admin/outbox/bulk`, consent-aware); compose UI pending. Workshop-signup and hardware-holder lists wait for B18 / hardware checkout | B26 |
| Reminder emails | 🟡 send by hand as a bulk email to a segment; no scheduled reminders yet | B26 |

## Event day

| Old feature | Status | Task |
| ----------- | ------ | ---- |
| Unique QR per attendee, in the email and on the dashboard | 🔍 | — |
| Staff check-in by QR / email; check-in counter | 🔍 | — |
| Force check-in (override for non-accepted walk-ins) | 📋 | B44 |
| Self check-in (virtual events) | ✖ it trusted a client-sent email; no virtual events planned | — |
| Schedule, admin-editable | 🔍 run of show | — |
| Schedule visible to attendees + "upcoming" on home | 📋 | F22 |
| Public schedule feed for the hackathon website | 🟡 run of show (JSON + .ics) built; workshops join once B18 exists | B45 |
| Meal check-in | ➕ 🔍 | — |
| "You're checked in" email + calendar invite | ➕ 🔍 | — |

## Workshops (old: RSVP-able events)

| Old feature | Status | Task |
| ----------- | ------ | ---- |
| Events with `rsvpable` + `max_seats` | ✅ admin CRUD, publication and atomic capacity; organizer assignment deferred | B18, B19 |
| RSVP / un-RSVP to an event | ✅ accepted attendees, overlap warnings and My workshops; waitlist deferred | B19, F17 |
| Per-event attendance check-in | ✅ Rotating attendance code, staff QR add, event check-in guard, counts and CSV | B21 |
| Workshop materials / announcements | ➕ 📋 visible to every accepted attendee | B20 |
| Workshop raffle | ✅ Attendee-only draw after workshop (early override), claims/redraw audit, collection emails and winner cards | B21 |
| Calendar invites per workshop | ✅ signup, changes and cancellations; stable UID and sequence; subscription feed deferred | B19 |

## Hardware

| Old feature | Status | Task |
| ----------- | ------ | ---- |
| Inventory CRUD (name, category, location, link, count) | ✅ | B22, F20 |
| Search by item id / name | ✅ | B23, F20 |
| Checkout / return, per-item history log | ✅ staff-only, atomic stock and retained history | B22 |
| "All checked out" list | ✅ | B22, F20 |
| Barcode label CSV | ✅ printable item QR labels | B22 |
| Slack reminders to return hardware | ✅ background email reminders | B22, B26 |
| Facilities page (makerspace tools list, `hum-xii`) | ✅ | B23, F20 |

Individual unit tracking and the optional reserve/request queue are deferred.

## Mentorship

| Old feature | Status | Task |
| ----------- | ------ | ---- |
| Help tickets with screenshot, resolve / deny, search | ✖ created on Discord instead (✅ home page links to the mentorship channel via `ORG_DISCORD_MENTORSHIP_URL`) | B31 |
| Mentor notifications by tech tag; Slack DM link | ✖ Discord | B31 |

## Projects, prizes & judging

| Old feature | Status | Task |
| ----------- | ------ | ---- |
| Project submission with team members | 🟡 teams + their Devpost link live on the dashboard (B15); projects are imported from Devpost | B24b |
| Public project gallery | ✖ Devpost hosts it | — |
| Power-outlet needs per project | 📋 | B24b |
| Prizes / tracks, participants pick prizes, assign winners | 📋 | B24h |
| Judge assignments (old Rails: tags, mass assign) | ✖ replaced by the 2025 judging platform's slotted generator | B24a, B24e |
| Printed judging forms (`paper_judging`) | 🟡 printable table signs only | B24c |
| Judging results + CSV | 📋 (the 2025 app never computed results) | B24g |
| **2025 judging:** two-step desk → table check-in | 📋 | B24c |
| **2025 judging:** calibration rounds + judge bias | 🟡 pure bias formula ported and tested; calibration flow pending | B24d |
| **2025 judging:** time-slotted assignments + verifier | 🟡 pure generator/verifier ported and tested; API integration pending | B24a, B24e |
| **2025 judging:** one-at-a-time scoring, skip, rejudge, assignment sheet | 📋 | B24f |
| **2025 judging:** progress board ("leaderboard") | 📋 | B24g |

## Finance

| Old feature | Status | Task |
| ----------- | ------ | ---- |
| Attendee travel reimbursements (2018 branch, never merged) | ✖ not offered this year | B39 |
| Organizer teams | ➕ 📋 | B33 |
| Budget with lines (components) owned by teams | ➕ 📋 | B34 |
| Team expenses, closed when paid by the hackathon | ➕ 📋 | B35 |
| Organizer reimbursement requests + amount-owed tracking | ➕ 📋 | B36 |
| Finance reports / exports | ➕ 📋 | B37 |
| Funding / income (entered by admins) | ➕ 📋 | B38 |
| HackerForce sponsorship CRM (companies, contacts, tiers, campaigns) | ✖ no longer needed | — |

## Platform

Technical settings is a new platform feature under review on `feature/tech-settings-2`: admin-only writes to the server dotenv file, write-only metadata, atomic saves with a previous-file backup, validation, removal, and an opt-in restart flow.

| Old feature | Status | Task |
| ----------- | ------ | ---- |
| Feature flags per module | 🟡 backend ✅ (`OrgSettings.features`, `requireFeature`, gates meals; each new module must mount it); nav hides meals items; full nav config is F13 | B25, F13 |
| Per-hackathon config repo (names, texts, branding) | 🟡 backend ✅ runtime branding API (`GET /api/meta/branding`, admin settings, logo upload) + admin card; the site still needs to apply it (colour flags fix) | B28, F12 |
| CSV exports (applications, events, judging, projects) | 🟡 applications, check-ins, meals done; hardware done; workshops, judging, projects pending | B29 |
| Resume bulk download (`download_resumes.py`) | ✅ ZIP of consenting accepted applicants | B29 |
| Error reporting (Sentry/Raven) | 📋 | B46 |
