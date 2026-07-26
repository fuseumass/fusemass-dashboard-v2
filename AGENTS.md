# AGENTS.md — HackUMass Dashboard

Rules for any AI agent or contributor working in this repository. Read this and
[`design.md`](./design.md) **before writing code**.

## Golden rules

1. **Plain, old-style JavaScript only.** No TypeScript (`.ts`/`.tsx`) and **no
   enforced type-checking** — no `// @ts-check`, no `checkJs`, no `tsc`. Values
   are dynamically typed and may be coerced on the fly. JSDoc `@param`/`@returns`
   is encouraged as *documentation*, but never as a checker. See `design.md` §3.
2. **Backend is Express 4 ("E4") + CommonJS.** Use `require` / `module.exports`,
   named `function` handlers, and the classic `(req, res, next)` /
   `(err, req, res, next)` middleware signatures. Do not introduce Express 5
   idioms or ESM `import` in `Backend/`.
3. **Mongoose for all data.** One schema per file in `Backend/schemas/`, each
   with a JSDoc `@typedef`. Start with `User`; add schemas as features need them.
4. **Auth is JWT-based.** `utils/parseToken` is mounted at the top of
   `server.js` and puts the decoded token on `req.user`. Gate routes with
   `utils/isAuthenticated` and `utils/isAdmin`. Never trust a role from a
   request body — read it from `req.user`.
5. **Layering:** `routes → controllers → schemas`. Routes wire URLs to
   controllers + guards; controllers hold logic; schemas own data shape.

## Before you commit

- Backend: every file must pass `node --check` (valid syntax). No type-check step.
- Frontend: `cd frontend && npm run lint` must pass (Biome).
- Every new backend file starts with `"use strict";`.
- Every exported function has JSDoc `@param` / `@returns` for documentation.

## Project-specific notes

- **The frontend has its own `frontend/AGENTS.md`** with a warning that this is
  Next.js 16 (App Router) with breaking changes vs. older Next. Consult
  `frontend/node_modules/next/dist/docs/` before writing frontend routing code.
- Login / signup / dashboard pages are intentionally minimal HTML; design work
  is tracked separately in [`issues.md`](./issues.md).
- Roles are `applicant` (default on register) and `admin` (promoted by an
  existing admin via the admin API). Applicants can only apply — as an
  individual, group, or team.

## Where things live

See the repository layout table in [`design.md`](./design.md) §2.
