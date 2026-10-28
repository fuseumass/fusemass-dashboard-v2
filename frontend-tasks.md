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

**In review on `feature/qr-checkin`** (don't start these again): the applicant's
QR card on the home page, the staff **Check-in** screen (camera + handheld
scanner + name search + arrivals counter), the **Meal check-in** screen, the
admin **Meals** and **Run of show** pages, and the shared
`components/QRScanner` + `components/CheckInStation`, which the hardware and
judging screens below should reuse.

Every old-platform feature and its task is tracked in
[`feature-parity.md`](./feature-parity.md).

> **Before writing routing code:** this is Next.js 16 (App Router) with breaking
> changes. Read the relevant guide in `frontend/node_modules/next/dist/docs/`
> first (see `frontend/AGENTS.md`).

---

## Design system: shadcn/ui + Tailwind (do these first, in order)

Every page today is hand-rolled inline `style={{…}}` objects plus a few global
classes (`.btn`, `.card`, `.input`) in `globals.css`. That's why pages drift
apart in spacing, type sizes and states. Goal: one component library, one set
of tokens, no inline styles in pages. **F10 → F11 → F12 → F13** are the
foundation; after that, F14 pages can be split across people.

### F10. Set up shadcn/ui (plain JS, Tailwind v4) (Keshav)
- [x] `npx shadcn@latest init` in `frontend/` with **`"tsx": false`** in
      `components.json`. The repo bans TypeScript (`AGENTS.md` golden rule
      1), so components must be generated as `.jsx`/`.js`. Check no
      `tsconfig.json`, `.ts` or `.tsx` lands in the PR.
      *Done:* `components.json` has `tsx: false` (style `radix-nova`); components are `.jsx`. No `tsconfig.json`, `.ts` or `.tsx` in the repo.
- [x] Tailwind v4 is already installed (`@import "tailwindcss"` in
      `globals.css`). Use shadcn's Tailwind v4 setup (`@theme inline`,
      `tw-animate-css`), not the v3 `tailwind.config.js` instructions.
      *Done:* `@theme inline` and `tw-animate-css` in `app/globals.css`; no `tailwind.config.js`.
- [x] Aliases: `@/components/ui`, `@/lib/utils` (`cn()` = `clsx` +
      `tailwind-merge`). `@/` already points at `frontend/`.
      *Done:* `cn()` in `lib/utils.js`. The generator's default `cn` package was replaced with `clsx` + `tailwind-merge`.
- [x] Add the base set: `button`, `input`, `label`, `textarea`, `select`,
      `checkbox`, `switch`, `card`, `badge`, `alert`, `dialog`,
      `alert-dialog`, `sheet`, `dropdown-menu`, `tabs`, `table`, `tooltip`,
      `separator`, `skeleton`, `sonner`, `form`, `command`, `popover`,
      `calendar`, `avatar`, `sidebar`, `breadcrumb`, `scroll-area`.
      *Done:* all present in `components/ui/`. The registry no longer ships `form`, so `form.jsx` is hand-written on `react-hook-form`; `input-group` came in as a `command` dependency.
- [x] Icons: `lucide-react` (shadcn default). Remove the emoji icons from
      `Sidebar.js`.
      *Done:* `Sidebar.js` was rebuilt on shadcn `Sidebar` with lucide icons; no emoji icons remain in the app.
- [x] Make Biome happy with the generated code (`npm run lint` must pass). Fix
      the code, or scope `biome.json` overrides narrowly to
      `components/ui/**`, never repo-wide.
      *Done:* `npm run lint` passes with **no** `biome.json` overrides: generated code was fixed in place.
- [x] Treat generated components as ours: edit them in place to match our
      tokens; don't wrap them in another layer.
      *Done:* edited in place (36 px controls, status variants on `Badge`/`Alert`, `loading` on `Button`, no blurred overlays).
- **Depends on:** none. **Related:** F11.

### F11. Design tokens and theme (Keshav)
- [x] Replace the ad-hoc variables in `globals.css` with shadcn's token set:
      `--background --foreground --card --popover --primary
      --primary-foreground --secondary --secondary-foreground --muted
      --muted-foreground --accent --accent-foreground --destructive --border
      --input --ring --radius`, plus our own `--success`, `--warning`,
      `--info` (each with a `-foreground`), mapped in `@theme inline` so
      `bg-primary`, `text-muted-foreground`, etc. work.
      *Done:* plus `--link` and `--overlay`; `--primary`/`--ring` follow `--brand` (F12 makes that runtime).
- [x] Light and dark values for every token. Dark mode is currently only the
      OS media query: add a `.dark` class strategy (`next-themes`) with a
      toggle in the user menu, defaulting to system.
      *Done:* `next-themes` (class strategy, default system); toggle in the user menu.
- [x] Type scale and spacing written down in one place (F16), e.g. page title
      `text-2xl font-semibold tracking-tight`, section title
      `text-base font-semibold`, body `text-sm`; 4 px spacing grid.
      *Done:* `frontend/DESIGN.md` sections 2 and 3.
- [ ] Delete the legacy `.btn`, `.btn-primary`, `.btn-ghost`, `.card`,
      `.input`, `.select`, `.textarea`, `.alert-*`, `.muted`, `.chip`,
      `.ac-*` classes **after** F14 migrates their last user (keep a list in
      the PR description).
      *Partly done:* the classes now read the new tokens, so un-migrated pages look right and follow dark mode; deleting them waits for F14. Removal list is in the PR description.
- [x] No raw hex colours in components (today: `#d97706` in
      `CheckInStation.js` and `admin/page.js`, the status colours); use tokens.
      *Done:* `#d97706` and the `rgba` scrims now use `--warning` / `--overlay`. Exceptions kept on purpose: the Google logo colours and the sandboxed email preview in Settings.
- **Depends on:** F10.

### F12. Fix the primary/secondary colour flags (bug)
**Symptom:** setting the brand colours per hackathon doesn't change the
site. **Causes found:**
1. `NEXT_PUBLIC_BRAND_COLOR` is **inlined at build time**, and every page is
   prerendered static (`next build` shows ○ for all routes). Changing the env
   var on a deployment, or running one image for several hackathons, has no
   effect until a rebuild.
2. **There is no secondary colour.** Only `--brand` exists (set inline on
   `<html>` in `app/layout.js`); nothing reads a `SECONDARY` setting
   anywhere.
3. `--brand-foreground` is hard-coded `#ffffff`, so a light brand colour (e.g.
   yellow) gives unreadable buttons.
4. Several colours bypass the variable entirely (hard-coded hex values,
   `--success`, the Google button).
5. A malformed value (e.g. `4f46e5` without `#`) fails silently and falls back
   to the default.

**Fix:**
- [ ] Read branding at **runtime** from `GET /api/meta/branding` (B28) in the
      root layout (a server component), and write
      `--primary`/`--secondary`/`--accent` (+ computed `-foreground`) into a
      `<style>` on `<html>`. Revalidate on an interval (e.g.
      `fetch(..., { next: { revalidate: 60 } })`) so pages can stay static.
      Read the Next 16 docs on caching/revalidation before choosing.
- [ ] Compute each `-foreground` (black or white) from the colour's
      contrast, aiming for WCAG AA 4.5:1. Derive hover/ring shades from the
      base colour with `color-mix()` rather than asking for more settings.
- [ ] Admin Settings → Branding: colour pickers + hex input with validation, a
      live preview (button, badge, link, sidebar item, on light and dark), a
      contrast warning, and logo upload.
- [ ] Keep `NEXT_PUBLIC_*` only as a last-resort fallback when the API is
      unreachable; document the order (admin setting → server env → default)
      in `.env.local.example`.
- [ ] Use `--secondary` somewhere meaningful (secondary buttons, sidebar
      active state, chart series), not just define it.
- **Backend ready (B28, B25):** `GET /api/meta/branding` (public, cacheable
  60 s) returns `{ branding: { orgName, primaryColor, secondaryColor,
  accentColor|null, logoUrl|null, logoDarkUrl|null, faviconUrl|null },
  features: { meals, hardware, workshops, judging, raffle } }`. Colours are
  always valid `#rrggbb`. Image URLs are absolute, or root-relative
  (`/api/meta/branding/files/…`) for uploads when the server has no
  `API_PUBLIC_URL`: prefix those with the API URL (see `imageSrc` in
  `components/BrandingFeaturesSettings.js`). When the API is unreachable fall
  back to `NEXT_PUBLIC_*`.
- **Landed with B28 (basic):** `components/BrandingFeaturesSettings.js`, a
  plain admin card for name, three colours (picker + hex, validated), logo /
  dark logo / favicon upload or pasted https URL, and the module switches,
  mounted on the settings page. **Still F12:** the root layout applying the
  branding (the site does not read the API yet), `-foreground` contrast, the
  live preview, the contrast warning, using `--secondary`, the favicon in
  `metadata`, and moving this card into the Branding / Features tabs.
- **Depends on:** F11, B28. **Related:** T14.

### F13. App shell and navigation
- [x] Rebuild `app/dashboard/layout.js` + `Sidebar.js` on shadcn `Sidebar`:
      collapsible on desktop, a `Sheet` drawer on mobile (today the 240 px
      sidebar never collapses, so phones get a squeezed page), and keyboard
      navigable.
      *Done:* collapses to an icon rail on desktop (Ctrl/Cmd+B), `Sheet` drawer under 768 px, real links so it is keyboard navigable, skip-to-content link.
- [x] One nav config file (`lib/nav.js`): items with `href`, `label`, `icon`,
      `roles`, `feature` (B25 flag), and group (Event day / Organize /
      Admin). The sidebar and any command palette both read it. Role and flag
      filtering happen there.
      *Done:* also drives breadcrumbs and a Ctrl K palette. Module flags (B25)
      come from `lib/features.js` `useFeatures()` in the dashboard layout.
- [ ] Top bar: breadcrumbs, page title, user menu (`DropdownMenu`: profile,
      theme toggle, log out). The org logo comes from the branding API.
      *Partly done:* breadcrumbs, `PageHeader` for titles, user menu with theme toggle and log out. Not done: a profile page (none exists, so the menu shows name, email and role) and the logo from the branding API (B28; still the env logo).
- [x] Highlight the active item for nested routes too (today
      `/dashboard/admin` is "active" only on exact match).
      *Done:* longest matching `href` wins, so Review is not active on Users.
- [x] Staff/kiosk mode: a full-width layout without the sidebar for the
      scanning screens (check-in, meals, hardware, raffle display) so they
      work on a phone at a table.
      *Done:* `kiosk: true` in `lib/nav.js` (check-in and meals now; hardware and raffle screens set it when they exist). The top bar keeps a menu button that opens the nav in a drawer.
- **Depends on:** F10, F11. **Related:** F0b.

### F14. Migrate every page to the design system
One PR per row is fine. Each page: no inline `style={{}}`, shadcn components
only, loading = `Skeleton`, empty = a designed empty state (F15), errors =
`Alert` or toast, confirmations = `AlertDialog` (no `window.confirm`).

| Page | Notes |
| ---- | ----- |
| `login`, `signup`, `forgot-password`, `reset-password`, `AuthShell` | `Card` + `Form`; field-level errors under inputs; password show/hide; one shared auth layout. |
| `dashboard` (home) | Status card with a `Badge`, QR card, "today" strip (next schedule item, my workshops, my hardware) once those exist (F17, F20, F22). |
| `dashboard/application` | Long form → sections with a sticky step indicator and autosave indicator; `Combobox` (`Command` + `Popover`) for university/skills (replaces `Autocomplete`/`TagAutocomplete`); file `Input` with upload progress; dynamic `formConfig` fields rendered by one `FieldRenderer`. |
| `dashboard/admin` (Review) | TanStack Table `DataTable`: sortable columns, status/round filters, search, pagination, column visibility; row click opens a `Sheet` with the full application + resume link + decision buttons; bulk accept/reject with confirmation. |
| `dashboard/admin/users` | `DataTable` + role `Select`; confirmation dialog when granting admin. |
| `dashboard/admin/settings` | `Tabs`: General, Branding (F12), Rounds, Application form, Email templates, Features (B25). Email template editor in a `Dialog` with a split preview pane. |
| `dashboard/admin/meals`, `dashboard/admin/schedule` | `DataTable` + create/edit in a `Dialog`; a date-time picker (`Calendar` + time input) instead of raw `datetime-local`; times shown in the event time zone. |
| `dashboard/staff/checkin`, `dashboard/staff/meals` | Kiosk layout (F13); full-width result banner (`Alert`, success/warning/destructive variants), large type; `sonner` toast + optional sound/vibration on scan; name search as a `Command` list. |

- **Depends on:** F10–F13. **Related:** T7.

### F15. Shared UX patterns
Build these once in `components/` and use them everywhere:
- [x] **Forms:** `react-hook-form` + `zod` (plain JS schemas) via shadcn `Form`;
      server errors mapped back onto fields; submit buttons show pending state
      and can't double-submit.
      *Done:* `components/ui/form.jsx`, `lib/forms.js` (`zodResolver`, `applyServerError`), `Button loading`; used by login, signup, forgot and reset password. `zodResolver` is our own because `@hookform/resolvers`' optional peers clash with zod 4.
- [x] **Data tables:** one `DataTable` wrapper (TanStack Table) with
      server-side pagination/sort/filter props, used by every admin list.
      *Done:* `components/DataTable.js` (TanStack Table v8): client mode by default, server mode via `pageCount`/`rowCount`, `pagination`, `sorting`. Used by Users.
- [x] **Empty states:** icon + one sentence + the primary action ("No meals
      yet. Create the first one.").
      *Done:* `components/EmptyState.js`.
- [x] **Loading:** `Skeleton` shaped like the content, not a "Loading…" line.
      *Done:* `components/skeletons.js`.
- [x] **Errors:** `app/error.js` + `app/dashboard/error.js` boundaries and a
      `not-found.js`; `apiFetch` errors shown via toast with a retry action.
      *Done:* boundaries and `not-found.js` done (Next 16 `unstable_retry`). `notifyError(err, { retry })` in `lib/notify.js` is the toast helper; pages adopt it as they are migrated (F14).
- [x] **Dates:** one `lib/datetime.js` that formats in the **event time zone**
      (`EVENT_TIMEZONE`, via the branding/meta API), so organizers in other
      zones see event times.
      *Done:* `formatDateTime/Date/Time/Range` use the event zone, labelling it when the viewer is elsewhere. The zone comes from `NEXT_PUBLIC_EVENT_TIMEZONE` for now; call `setEventTimeZone()` with the branding API value once B28 serves it.
- [x] **Copy:** sentence case, no exclamation marks in UI chrome, verbs on
      buttons ("Create meal", not "Submit").
      *Done:* written up in `DESIGN.md` section 5 and applied to the pages touched here.
- **Depends on:** F10.

### F16. Design guidelines ("sleek, not AI slop") + PR checklist
Write `frontend/DESIGN.md` and link it from the PR template (both done:
`frontend/DESIGN.md`, `.github/pull_request_template.md`). Concrete rules:
- [x] **Restraint:** one primary action per screen; the brand colour only for
      primary actions, focus and selection, not backgrounds or headings.
      Neutral surfaces, 1 px borders, minimal shadows.
- [x] **No generic AI look:** no purple-to-blue gradients, glowing blobs,
      glassmorphism, emoji as icons, cards inside cards, centred hero text on
      internal pages, or decorative illustrations on data screens. No
      "✨ Welcome back!" copy.
- [x] **Density:** staff/admin screens are tools; aim for Linear / Vercel
      dashboard density (`text-sm` tables, 36–40 px rows), not marketing
      spacing.
- [x] **Type:** one font family (Geist, already loaded), at most 4 sizes per
      page, weights 400/500/600 only; tabular numbers for counts and times.
- [x] **Motion:** 150–200 ms ease-out for overlays only; respect
      `prefers-reduced-motion`.
- [x] **States are designed:** every list has empty, loading, error and
      "many items" states; every button has disabled + pending states.
- [x] **Accessibility baseline (folds in F0b):** visible focus rings, labels on
      every input, 4.5:1 text contrast, full keyboard use, `aria-live` for scan
      results.
- [x] **PR checklist:** screenshots light + dark + 375 px mobile; no inline
      styles; no raw hex; lint passes.
- **Depends on:** none (write it alongside F10).

### F0. Visual design pass on auth + dashboard
Superseded by F10–F16 (design system, tokens, shell, page migration,
guidelines). Close this when F14 is done.

### F0b. Responsive + accessibility pass
Folded into F13 (mobile shell) and F16 (accessibility baseline). Do a final
audit with axe / Lighthouse on every page once F14 lands.
- **Depends on:** F13, F14.

---

## Check-in (event day)

### F2. First check-in UI (moderators + admins) - Jeng-Aun Chou
A staff page to look up an accepted applicant (search by name/email) and mark
them checked in; show who/when. Visible to moderators and admins.
- **Status:** done in review on `feature/qr-checkin` (QR scan + search,
  `/dashboard/staff/checkin`).
- **Depends on:** B5 (done). **Related:** T2.

### F3. Meal check-in UI + admin meal setup - Richarla Preston @charlajp
Admin: create/manage meal services (name, time window). Staff (mod+admin):
select the active meal and check attendees in, with a guard against double
serving.
- **Status:** done in review on `feature/qr-checkin` (`/dashboard/admin/meals`,
  `/dashboard/staff/meals`).
- **Depends on:** B6 (done), B7. **Related:** T3.

### F22. Event-day applicant home
- [x] Show accepted status even after applications close (needs B27; today the
      page says "Applications aren't open right now" to accepted attendees on
      event day). Basic version landed with B27 (`ClosedRoundStatus`: round
      name, "You're in" / "You're checked in", other statuses); restyle it when
      this page gets the "Today" view. Not handled yet: an attendee accepted in
      an earlier round while a *different* round is open still sees "Start your
      application" (`latest` is in the response; the page ignores it then).
- [ ] "Today" view: next run-of-show items, my workshops (F17), my hardware
      (F20), Discord + website links, QR always one tap away (pinned on
      mobile).
- [ ] `/dashboard/schedule`: the full run of show + workshops for attendees
      (the old dashboard had one), grouped by day, in the event time zone,
      with the current item highlighted and "Add to calendar".
- **Depends on:** B27. **Related:** F14.

---

## Workshops

### F17. Workshops for attendees
- [x] Scoped delivery: browse published workshops with host, time, place and
      spots left; sign up/cancel with pending states and overlap warnings;
      My workshops section ordered by time, accepted-applicant explanation.
      Day filtering, optimistic updates, calendar download/Google links,
      detail pages, announcements, attendance and raffles remain deferred.
- [ ] `/dashboard/workshops`: browse published workshops (time, host,
      location, spots left), filter by day; sign up / cancel with optimistic
      UI and a clear "Full" / "Waitlisted" state; overlap warning.
- [ ] "My workshops" tab in time order, each with **Add to calendar** (`.ics`
      download + Google Calendar link) and a link to the workshop's page.
- [ ] Workshop page `/dashboard/workshops/[id]`: details + the announcement
      feed (read-only, newest first, pinned posts on top, file chips that
      download through the signed-URL endpoint, linkified text, relative
      times; polls every ~15 s). **Every accepted attendee can open it and
      download materials**, signed up or not.
- [ ] **Attendance (Top Hat-style):** while the organizer has attendance
      open, the workshop page (and a banner on the home page) shows "Enter the
      code on screen": a large, auto-uppercase, 4–6 character input that
      submits on the last character. Then "You're checked in, and you're in
      the raffle". Only attendees checked in to the event can enter: if they
      aren't, show "Check in at the front desk first" instead of the input.
      Friendly errors for a wrong or stale code, attendance being closed, or
      too many tries.
- [ ] **Raffle:** the page explains "Attend and enter the code to be in the
      raffle, drawn after the workshop". Only attendees can win; signing up or
      viewing materials doesn't count. Winners get a "You won <prize>, collect
      it from <organizer room + location> after the workshop" card on the
      workshop page and the home page (the same text as the email).
- **Depends on:** B18, B19, B20, B21. **Related:** T9.

### F18. Workshop organizer screens
Visible only to `workshop_organizer`s for **their** workshops (plus admins).
- [ ] `/dashboard/organize`: list of my assigned workshops only.
- [ ] Workshop console `/dashboard/organize/[id]`:
  - **Announcements composer**, chat-style: multiline text + drag-and-drop
    files (multiple, with per-file progress and type/size errors before
    upload), post, pin/unpin, edit, delete; the feed below like a chat
    history.
  - **Sign-ups:** count vs capacity, list, CSV download.
  - **Attendance:** open (duration), extend and close; **Present** mode, a
    full-screen view for the projector with the rotating code in huge
    monospace characters, a countdown ring to the next rotation, and an
    optional QR; a live attendee count; "Add attendee" by scanning their QR
    (reuse `CheckInStation`) for people without a phone; signed up vs
    attended.
  - **Raffle** (from attendees only): the Draw button unlocks when the
    workshop ends (with an "end early" override); prize name + number of
    winners → draw with a short reveal in Present mode; shows "Winners have
    been emailed to collect from <organizer room>"; mark claimed or redraw
    for no-shows; history of draws.
- **Depends on:** B17, B20, B21, F13 (kiosk layout for Present mode).

### F19. Admin workshop management
- [x] `/dashboard/admin/workshops`: `DataTable` + create/edit `Dialog` (title,
      host, location, time, capacity, published, raffle on/off);
      cancel-workshop flow that warns how many people will be notified.
- [ ] Deferred with B17: assign organizers: user search (`Command`) → add/remove. **Moderators
      and admins can be assigned as-is**; for an applicant, offer to make them
      a `workshop_organizer` first; judges can't be picked. Assigned mods and
      admins see the workshop under "Organize" too.
- **Depends on:** B17, B18.

---

## Hardware (replaces F5)

### F20. Hardware checkout and inventory
- [x] Staff team column and changed-team badges, scanned attendee team, event-zone hardware deadline setting, and leave-team hardware warning.
- [x] **Checkout station** `/dashboard/staff/hardware` (kiosk layout): scan the
      attendee QR (reuse `CheckInStation`) → their open items appear → scan or
      search an item → confirm. Returns from the same screen: scan the
      attendee, tap "Return" per item. Clear errors for "not checked in", "out
      of stock" and "limit reached".
- [x] **Inventory admin** `/dashboard/admin/hardware`: `DataTable` (name,
      category, location, available/total), create/edit `Dialog`, CSV import
      with a preview, printable QR label sheet.
- [x] **Outstanding** view: who has what, overdue first, "email everyone still
      holding hardware" (B26).
- [x] **Participant** `/dashboard/hardware`: browse what's available (search,
      category chips, availability badge) and "My hardware" with due times.
- **Depends on:** B22, B23. **Related:** T10.

Implemented in the hardware working tree. Optional individual unit tracking and
the reserve/request queue are deferred. Printable labels identify item types.

Verification: lint and an offline-font Webpack build pass. Standard Turbopack
build and light/dark/375 px screenshots are blocked by sandbox network and
local port restrictions. MongoDB integration tests require the reviewer environment.

---

## Judging (merge HackUMass-Judging-New; replaces F6)

How the 2025 judging platform works, and its bugs, are written up in
`backend-tasks.md` → **Judging**. These screens replace its EJS views. The
mapping is in the table below. **Judges score on phones while walking the
floor: build the judge screens mobile-first, in the kiosk layout (F13).**

| 2025 view | Dashboard screen | Task |
| --------- | ---------------- | ---- |
| `login.ejs` (CSV login) | Normal login + judge invite / set-password page | F27 |
| `tutorial.ejs`, `thankyoututorial.ejs` | Judge → Calibration | F21a |
| `judge.ejs`, `thankyou.ejs` | Judge → Current project | F21a |
| `skip.ejs` | Judge → Skipped | F21a |
| `assignments.ejs` | Judge → My assignments | F21a |
| `checkin1-admin.ejs` | Staff → Judging desk | F21b |
| `checkin2-participant.ejs` | Attendee home → "Check in at your table" | F21b |
| `leaderboard.ejs` (progress) | Admin → Judging → Progress | F21c |
| — (didn't exist) | Admin → Judging → Import, Rooms, Rubric, Assignments, Results, Prizes | F21c |
| `landing.ejs`, `emails/*.ejs` | Not needed (dashboard home; email templates) | — |

### F21a. Judge screens
- [ ] `/dashboard/judging` routes the judge to calibration until it's done,
      then to their current project.
- [ ] **Calibration:** "Practice project 1 of 3", the same rubric form as real
      judging, a short explainer ("everyone scores the same projects so we
      can correct for strict and generous judges"), then "Calibration done".
- [ ] **Current project:** a large table number + room, then project name,
      category, Devpost link; progress "4 of 12"; the rubric with each
      criterion's **guiding questions** (from the rubric's `help`), entered as
      segmented 0–N buttons (no free number inputs: the 2025 form only clamped
      in the browser); comments; **Submit & next** and **Skip**. Prevent double
      submit. When the queue is done: "All done, thank you".
- [ ] **Skipped:** list with table/room, tap to score. Scoring a skipped
      project returns you to your *current* project and doesn't skip ahead
      (the 2025 bug).
- [ ] **My assignments:** the full list in order, including the first (2025
      dropped it), each marked done / skipped / upcoming from real scores.
- [ ] Optional slot timer per project if B24e's decision picks (a).
- [ ] Offline tolerance: keep the unsent form in local storage and retry on
      reconnect, since venue Wi-Fi drops.
- **Depends on:** B24d, B24f, F27.

### F21b. Team check-in screens (desk → table)
- [ ] **Judging desk** (`/dashboard/staff/judging-desk`, kiosk layout, reusing
      `CheckInStation`): scan any team member's attendee QR → show the
      project, members and the assigned **table + room in huge type** →
      done. Errors: no project found, already assigned (show its table),
      room full. If they're on several projects, pick one.
- [ ] **Table check-in** for attendees: once their project has a table, the
      home page shows "Go to table 34 in S131, then scan the QR on your table"
      with the camera scanner. Results: done / wrong table (say the right
      one) / not desk-checked-in yet.
- [ ] Admin: print table signs (from B24c), the bulk fallback ("check-in
      failed: assign everyone"), with a typed confirmation, and clear a
      project's table.
- **Depends on:** B24c.

### F21c. Admin judging console
`/dashboard/admin/judging`, with tabs:
- [ ] **Import:** upload the Devpost CSV → preview table (new / updated /
      errors, unmatched member emails) → confirm.
- [ ] **Rooms & tables:** room list (name, order, capacity, hardware) with
      totals vs project count, so admins see shortages before the event.
- [ ] **Rubric:** criteria editor (label, guiding questions, min/max, weight,
      general/category), locked once scores exist; calibration projects.
- [ ] **Judges:** list with hardware flag, invite status, calibration done,
      bias, progress; invite and bulk-invite (F27).
- [ ] **Assignments:** parameters (judgings per project) → Generate → show the
      verifier report and per-judge queues → Activate. Version history; add
      or remove a judge; withdraw a project.
- [ ] **Progress** (the 2025 "leaderboard"): per project scores in / assigned,
      per judge done / total, missing scores first; auto-refresh; a lobby
      screen version.
- [ ] **Results:** ranking overall and per category, with a raw vs
      bias-adjusted toggle, score counts and warning badges (too few scores,
      uncalibrated judges); freeze scoring; CSV exports.
- [ ] **Prizes:** CRUD, suggested winners from the category ranking, assign
      and publish (B24h).
- Every action is a button that POSTs, with a confirmation where it's
  destructive. Nothing changes data through a link.
- **Depends on:** B24b–B24h.

### F27. Judge role in the UI
- [ ] Judges get their own nav: **Judging** only (calibration, current
      project, skipped, my assignments). No Application, QR card, workshops,
      meals or schedule items. The home page for a judge is the judging card.
- [ ] Users page: add `judge` to the role list; admins can't demote themselves
      (existing rule).
- [ ] Judge invite acceptance: `/judge/accept?token=…` → set a password (or
      continue with Google) → land on `/dashboard/judging`. Expired or used
      token → a clear message and "ask an organizer to resend".
- [ ] Admin → Judging → Judges: invite one, bulk-invite from CSV (preview,
      then send), resend invite, remove judge.
- [ ] Client guards on every judging page (judges + admins only); the API
      enforces it anyway (B47).
- **Depends on:** B47. **Related:** F13 (nav config with `roles`).

### F5. Hardware data view (moderators)
Replaced by **F20**.

### F6. Judging progress view (moderators)
Replaced by **F21a–F21c**.

---

## Finance (moderators + admins only)

Money is shown with `Intl.NumberFormat` in the budget's currency. Inputs take
dollars and send cents (never send floats). Finance nav items are hidden from
every other role (also enforced by the API, B33–B36).

### F23. Teams and budget setup (admin)
- [ ] `/dashboard/admin/finance/teams`: create teams, add/remove moderators
      and admins (user search `Command`), mark leads; a warning badge on
      members who are no longer staff.
- [ ] `/dashboard/admin/finance/budget`: the budget's lines in a `DataTable`
      grouped by team: allocated / committed / spent / remaining, an inline
      progress bar per line (red when over), add/edit line `Dialog`,
      reallocation with a required reason (shown in the line's history), and a
      lock budget action with confirmation.
- **Depends on:** B33, B34.

### F24. Team budgets and expenses (mods + admins)
- [ ] `/dashboard/finance`: one card per team I'm on, with allocated vs spent
      vs committed and a small spend-over-time chart, then that team's lines.
      Moderators see **only their own teams**: no other teams, no
      budget-wide totals, no income. Admins also get an "All teams" view.
- [ ] Add expense (`Sheet` form): line (only my teams' lines), vendor,
      description, amount, date, **"Who paid?"** = *the hackathon* (org card /
      invoice) or *me* (turns it into a reimbursement request, F25), and
      receipt drag-and-drop with image/PDF preview.
- [ ] Expenses `DataTable`: filters (team, line, status, payer, date), status
      `Badge`s (`open`, `closed`, `submitted`, `approved`, `paid`, `rejected`,
      `voided`), row `Sheet` with receipts, the history timeline, and actions
      allowed for my role: **Mark closed** (paid by the hackathon, with a
      receipt), edit while open, void with a reason.
- **Depends on:** B35. **Related:** F15 (forms, tables).

### F25. Reimbursements and money owed
- [ ] **Mine** (`/dashboard/finance/reimbursements`): my requests with status,
      amount and dates; withdraw while submitted; my payout handle (Venmo/Zelle
      username) in a profile field, with "only finance admins can see this".
- [ ] **Admin queue** (`/dashboard/admin/finance/reimbursements`): tabs
      *To review* / *Approved, unpaid* / *Paid* / *Rejected*. Approve or
      reject (reason required); **Mark paid**, single or batch, with method +
      reference. Controls are disabled with a tooltip on your own requests
      (separation of duties).
- [ ] **Owed** summary at the top: total approved-but-unpaid, awaiting review,
      a per-person list (name, amount owed, oldest request age, payout handle),
      and CSV export.
- [ ] Reports page: budget vs actual by team and line, and an exports menu
      (expenses CSV, reimbursements CSV, receipts zip for a date range) (B37).
- **Depends on:** B36, B37. **Related:** T16.

---

## Admin insights

### F26. Statistics page
- [x] `/dashboard/admin/stats` (admins only, in the sidebar): KPI row
      (applications, accepted, checked in, meals served, workshop attendance,
      hardware out; the last two show a dash until B21/B22 feed them),
      applications by status over time (stacked columns, table view,
      hover tooltip), by-round table, and breakdowns by school, education
      level, graduation year, first-time hackers, gender, major, T-shirt size
      and every custom choice question, filterable by round and status.
      Plain CSS/SVG charts in one self-contained file with local `--st-*`
      colour tokens (light + dark, checked with the dataviz validator),
      because shadcn/Recharts (F10) and the theme tokens (F11) haven't landed.
      **Swap to the shadcn charts and F11 tokens when they do.**
- [x] Event-day mode: auto-refresh every 30 s for a lobby screen (remembered
      in `localStorage`, paused while the tab is hidden).
- [x] An Exports card on the page downloads the B29 files (applications,
      check-ins, meals CSV; resume ZIP for sponsors with a consent question).
- **Depends on:** B43.

---

## Supporting

### F9. Logo assets - Richarla Preston @charlajp
Drop real `public/logo.png` and `public/logo-v2.png`, set the
`NEXT_PUBLIC_*` env vars per deployment. The `Logo` component already falls back
to the org name text until then. (After F12/B28, logos are uploaded in Admin →
Branding instead.)
- **Depends on:** none.
