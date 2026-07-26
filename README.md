# Hackathon Dashboard — Design & Code Practices

This document is the single source of truth for **how we write code** in this
repository. Read it before opening a PR. It is deliberately opinionated so that
the whole team produces code that looks and behaves consistently.

This is a **white-label** platform: it is not tied to any single hackathon.
Branding (name, logos, colors) comes from environment variables so any hackathon
can deploy it. See §8 and the `.env.example` files.

---

## 0. Git workflow — branch + PR only (hard rule)

**Never commit directly to `main`.** All work happens on a branch and lands
through a **pull request** that is reviewed and passes checks.

1. Branch off `main`: `git checkout -b feature/<short-name>`.
2. Commit to your branch and push it.
3. Open a pull request into `main`. Get it reviewed; let CI (lint +
   `node --check`) pass; then merge.

> **Enforcement:** committing directly to `main` is a violation. Anyone who
> pushes to `main` will be moved to a **restricted state** and will lose the
> ability to commit to `main` in the future (branch protection + revoked direct
> push access). When in doubt, open a PR.

`main` is protected. Treat a red CI check as a blocker, not a suggestion.

---

## 1. The stack: an older MENN

We run an intentionally "classic" **MENN** stack:

| Letter | Piece    | Version / style we use                          |
| ------ | -------- | ----------------------------------------------- |
| **M**  | MongoDB  | via **Mongoose** ODM (schemas in `Backend/schemas/`) |
| **E**  | Express  | **Express 4.x** ("E4") — classic middleware style |
| **N**  | Next.js  | Next 16 App Router, plain JavaScript components |
| **N**  | Node     | CommonJS (`require` / `module.exports`) on the backend |

We do **not** use TypeScript, and we do **not** use the newest Express 5 idioms.
We write **plain, dynamically typed, old-style JavaScript** — JSDoc is used to
*document* function params, but there is **no enforced type-checking** (see §3).

> **Why "older" and dynamic?** The team standardizes on patterns that are stable,
> widely documented, and easy for new hackers to read. Dynamic typing lets us
> coerce and reshape values on the fly (form strings → numbers/booleans, loose
> request bodies, quick schema tweaks) without fighting a type-checker — which
> matters when applications may need to open on short notice. Predictability and
> speed beat novelty and ceremony.

---

## 2. Repository layout

```
Dashboard/
├─ Backend/                 # Express 4 + Mongoose API
│  ├─ server.js             # entry point; mounts global parseToken at the top
│  ├─ config/db.js          # Mongoose connection
│  ├─ schemas/              # Mongoose schemas (User, Application, Team, ...)
│  ├─ utils/                # parseToken, isAuthenticated, isAdmin, signToken
│  ├─ controllers/          # request handlers (business logic)
│  ├─ routes/               # express.Router() route tables
│  └─ .env.example          # copy to .env
│
├─ frontend/                # Next.js 16 App Router (its own git repo)
│  ├─ app/                  # routes: login, signup, dashboard, ...
│  └─ lib/api.js            # fetch wrapper + JWT storage
│
├─ README.md                # this file (design & practices)
├─ AGENTS.md                # rules for AI agents / contributors
├─ backend-tasks.md         # backend backlog (B# tasks)
├─ frontend-tasks.md        # frontend backlog (F# tasks)
└─ testing-tasks.md         # testing/QA backlog (T# tasks)
```

**Layering on the backend:** `routes → controllers → schemas`. Routes only wire
URLs to controller functions and guards. Controllers hold logic. Schemas own the
data shape. Do not query the database directly from a route file.

---

## 3. Old-style, dynamically typed JavaScript (no type-checking)

We write plain JavaScript with **no enforced type-checking**. There is no
`// @ts-check`, no `jsconfig.json` with `checkJs`, and no `tsc`/`typecheck`
step. Values are free to change shape at runtime — coerce and reshape them where
it's convenient (e.g. `Number(req.query.page)`, truthy checks on loose bodies).

Every backend `.js` file starts with just:

```js
"use strict";
```

**JSDoc is for humans, not a compiler.** We still document functions so the next
person (and the editor's autocomplete) knows what goes in and out — we just
don't let a checker block us:

- **Annotate every exported function** with JSDoc `@param` / `@returns`, using
  plain descriptions. Prefer `@param {object} req - Express request.` over
  framework type imports:

  ```js
  /**
   * @param {object} req - Express request (req.user set by parseToken).
   * @param {object} res - Express response.
   * @param {function} next - Express next callback.
   * @returns {void}
   */
  function handler(req, res, next) { /* ... */ }
  ```

- A `@typedef` is fine when it genuinely documents a shape (see the
  `TokenPayload` typedef in `utils/signToken.js`). Keep them lightweight.
- **No inline `/** @type ... *\/` casts.** Just read the property:
  `var user = req.user;`. `parseToken` guarantees `req.user` is either the
  decoded payload `{ id, email, role }` or `null`.
- **Validate at runtime instead of trusting types.** Check required fields at the
  top of a controller and return `400` early (see §7). Runtime guards are our
  safety net, not a type-checker.

---

## 4. Express 4 ("E4") conventions

- **CommonJS only:** `var x = require("...")` and `module.exports = ...`.
- **Named function declarations** for handlers and middleware — not anonymous
  arrows. Named functions give readable stack traces and match our JSDoc:

  ```js
  function login(req, res) { /* ... */ }
  module.exports = { login: login };
  ```

- **Middleware signature is sacred.** Regular middleware is `(req, res, next)`;
  the **error handler is `(err, req, res, next)`** — Express 4 detects an error
  handler by its four arguments, so never drop `next` there.
- **One responsibility per middleware.** `parseToken` decodes; `isAuthenticated`
  gates on login; `isAdmin` gates on role. They compose:

  ```js
  router.get("/applications", isAdmin, adminController.listApplications);
  ```

- **Always end the response or call `next()`** on every code path. A handler that
  neither responds nor calls `next` hangs the request.
- **Promises over callbacks** for async work (Mongoose returns promises); catch
  errors and translate them to a JSON error response.

---

## 5. Authentication model (JWT)

We pass a **JWT** between the frontend and backend. There are no server-side
sessions.

1. On register/login the backend signs a token with `utils/signToken.js`. The
   payload is small: `{ id, email, role }`.
2. The frontend stores the token (`lib/api.js`) and sends it on every request as
   `Authorization: Bearer <token>`.
3. **`utils/parseToken.js` is mounted once at the very top of `server.js`.** It
   pulls the token off each request, hands it to `jwt.verify` to decode, and
   attaches the result to **`req.user`** (or `null` when there is no valid
   token). It never rejects a request itself.
4. Route guards do the gating:
   - `isAuthenticated` → 401 if `req.user` is missing.
   - `isAdmin` → 401 if missing, 403 if `req.user.role !== "admin"`.

**Never** trust a role sent in a request body — always read it from the decoded
`req.user`. **Never** put secrets in the JWT payload; it is readable by anyone
holding the token.

---

## 6. Data & schema conventions (Mongoose)

- One schema per file in `Backend/schemas/`, exporting the compiled model.
- Give each schema a JSDoc `@typedef` describing its attributes.
- Use `{ timestamps: true }` so every document has `createdAt` / `updatedAt`.
- Store **hashes, never plain passwords** (`bcryptjs`), and strip sensitive
  fields in a `toJSON` transform (see `schemas/user.js`).
- Use `enum` for closed sets of values (`role`, application `type`, `status`).
- Add indexes for fields you query or that must be unique (`email`, one
  application per applicant).

---

## 7. API conventions

- Prefix all backend routes with `/api`.
- Return JSON. Success shapes: `{ user }`, `{ token, user }`, `{ application }`,
  `{ applications }`. Error shape: `{ error: "human readable message" }`.
- Use conventional status codes: `200` ok, `201` created, `400` bad input,
  `401` unauthenticated, `403` forbidden, `404` not found, `409` conflict,
  `500` server error.
- Validate required inputs at the top of the controller and return `400` early.

---

## 8. Frontend conventions (Next.js App Router)

- One route per folder under `app/` with a `page.js`.
- Pages that use state, effects, or event handlers must start with
  `"use client"`.
- All network access goes through `lib/api.js` (`apiFetch` for JSON, `apiUpload`
  for multipart/resume) so the JWT header is attached consistently.
- Anything a `useSearchParams()` reads must be wrapped in a `<Suspense>`
  boundary (Next 16 requirement) — see the auth pages for the pattern.
- Styling uses Tailwind v4 plus a small design-system layer of component classes
  in `app/globals.css` (`.card`, `.input`, `.btn`, `.field-label`, …). The brand
  accent is the `--brand` CSS variable, set from `NEXT_PUBLIC_BRAND_COLOR`.
- White-label branding is read via `lib/config.js` (org name + logos + color).
  Reusable pieces live in `components/` (`Logo`, `Sidebar`, `GoogleButton`,
  `Autocomplete`, `TagAutocomplete`, `AuthShell`). Further visual polish is a
  task (see `frontend-tasks.md`, F0).
- Import with the `@/` alias (configured in `jsconfig.json`).

---

## 9. Formatting & linting

- **Frontend:** Biome. `npm run lint` to check, `npm run format` to fix.
- **Backend:** 2-space indentation; every file must at least pass
  `node --check`. No type-checking step (see §3).
- Keep comments explaining **why**, not **what**. The code says what.
