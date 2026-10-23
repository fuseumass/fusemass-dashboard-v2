# AGENTS.md — Hackathon Dashboard

Rules for any AI agent or contributor working in this repository. Read this and
[`README.md`](./README.md) **before writing code**. This is a **white-label**
platform — no hackathon-specific names in code; branding comes from env vars.

## Golden rules

0. **Branch + PR only — never commit to `main`.** Committing directly to `main`
   is a violation that leads to a restricted state (loss of direct-push access).
   See `README.md` §0.
1. **Plain, old-style JavaScript only.** No TypeScript (`.ts`/`.tsx`) and **no
   enforced type-checking** — no `// @ts-check`, no `checkJs`, no `tsc`. Values
   are dynamically typed and may be coerced on the fly. JSDoc `@param`/`@returns`
   is encouraged as *documentation*, but never as a checker. See `README.md` §3.
2. **Backend is Express 4 ("E4") + CommonJS.** Use `require` / `module.exports`,
   named `function` handlers, and the classic `(req, res, next)` /
   `(err, req, res, next)` middleware signatures. Do not introduce Express 5
   idioms or ESM `import` in `Backend/`.
3. **Mongoose for all data.** One schema per file in `Backend/schemas/`, each
   with a JSDoc `@typedef`. Start with `User`; add schemas as features need them.
4. **Auth is JWT-based.** `utils/parseToken` is mounted at the top of
   `server.js` and puts the decoded token on `req.user`. Gate routes with
   `utils/isAuthenticated`, `utils/isModerator` (moderators + admins), and
   `utils/isAdmin` (admins only). Never trust a role from a request body — read
   it from `req.user`.
5. **Layering:** `routes → controllers → schemas`. Routes wire URLs to
   controllers + guards; controllers hold logic; schemas own data shape.

## Before you commit

- Backend: every file must pass `node --check` (valid syntax). No type-check step.
- Backend: `cd backend && npm test` must pass. A **new route needs a row in the
  `MATRIX` in `backend/test/permissionMatrix.test.js`** (who may call it); the
  suite fails until you add one. Never return `passwordHash`, reset tokens or
  another user's check-in code (`qrId`) from a route.
- Frontend: `cd frontend && npm run lint` must pass (Biome).
- Every new backend file starts with `"use strict";`.
- Every exported function has JSDoc `@param` / `@returns` for documentation.

## Project-specific notes

- **The frontend has its own `frontend/AGENTS.md`** with a warning that this is
  Next.js 16 (App Router) with breaking changes vs. older Next. Consult
  `frontend/node_modules/next/dist/docs/` before writing frontend routing code.
- **UI work:** read [`frontend/DESIGN.md`](./frontend/DESIGN.md) first. Use the
  shadcn/ui components in `frontend/components/ui/` (plain JS) and the design
  tokens; no inline styles, no raw hex colours, no new uses of the legacy
  `.btn`/`.card`/`.input` classes. Attach light, dark and 375 px screenshots.
- Backlog lives in [`backend-tasks.md`](./backend-tasks.md),
  [`frontend-tasks.md`](./frontend-tasks.md), and
  [`testing-tasks.md`](./testing-tasks.md) (cross-linked as `B#`/`F#`/`T#`).
  [`feature-parity.md`](./feature-parity.md) tracks every feature of the old
  platforms (old dashboard, judging app) against this one;
  update its row when you land or drop a feature.
- **Roles:** `judge` → judging only, invited by admins; `applicant` (default) → can only apply; `moderator` → reviews
  applications (approve/reject) and later hardware/judging views; `admin` →
  everything, including org setup (settings, rounds, promoting users, editing
  the application form). Admin-only screens must also guard on the client.
- **First admin** is bootstrapped with the `SETUP_ADMIN` env var + `POST
  /api/auth/setup-admin`. **Google OAuth** availability = env credentials + env
  flag + the admin org setting (admins can toggle it off at runtime).

## Where things live

See the repository layout table in [`README.md`](./README.md) §2.
