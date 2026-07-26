# HackUMass Backend

Express 4 + Mongoose API for the HackUMass dashboard (the **E** and **M** of our
MENN stack). Plain, old-style JavaScript — dynamically typed, with JSDoc used to
*document* params but no enforced type-checking. See
[`../design.md`](../design.md) and [`../AGENTS.md`](../AGENTS.md) for conventions.

## Setup

```bash
cd Backend
cp .env.example .env      # then edit values
npm install
npm run dev               # node --watch server.js
```

You need a MongoDB instance (local `mongod` or a MongoDB Atlas URI in
`MONGODB_URI`).

## Scripts

| Command       | What it does           |
| ------------- | ---------------------- |
| `npm run dev` | Start with auto-reload |
| `npm start`   | Start once             |

## Layout

```
server.js          entry point; mounts global parseToken at the top
config/db.js       Mongoose connection
schemas/           User, Application, Team
utils/             parseToken (global), isAuthenticated, isAdmin, signToken
controllers/       auth, application, admin logic
routes/            express.Router() tables
```

## API

Base prefix: `/api`. All responses are JSON. Errors: `{ error }`.

| Method | Path                             | Auth      | Purpose                          |
| ------ | -------------------------------- | --------- | -------------------------------- |
| GET    | `/api/health`                    | public    | Liveness check                   |
| POST   | `/api/auth/register`             | public    | Create applicant, return JWT     |
| POST   | `/api/auth/login`                | public    | Log in, return JWT               |
| GET    | `/api/auth/me`                   | user      | Current user                     |
| POST   | `/api/applications`              | user      | Apply (individual/group/team)    |
| GET    | `/api/applications/me`           | user      | Your application (or null)       |
| GET    | `/api/admin/applications`        | admin     | List applications (`?status=`)   |
| PATCH  | `/api/admin/applications/:id`    | admin     | Accept/reject (`{ decision }`)   |
| PATCH  | `/api/admin/users/:id/role`      | admin     | Set a user's role (`{ role }`)   |

**Auth:** send `Authorization: Bearer <token>`. `parseToken` decodes it onto
`req.user`; `isAuthenticated` and `isAdmin` gate access.

> There is no admin until you create one — see issue #4 in
> [`../issues.md`](../issues.md).
