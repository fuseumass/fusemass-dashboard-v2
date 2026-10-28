"use strict";

// Role x route permission matrix (T12).
//
// Missing permission checks were the most common bug in both old platforms,
// so this file pins down who may call what, for EVERY mounted route:
//
//   1. The matrix: each route is listed once, with the access level it is
//      meant to have. Every role calls every route and must get 401/403 where
//      it is not allowed (and anything else, i.e. the guard let it through,
//      where it is).
//   2. The guard test: it walks Express's router stack and fails when a route
//      exists that isn't in the matrix (or the matrix lists one that no
//      longer exists), so a new route can't ship without somebody deciding who
//      may call it.
//   3. Denied requests are checked for side effects: with valid bodies and
//      real ids, nothing in the database changes and no email goes out.
//
// ADDING A ROUTE: add a row to MATRIX below. ADDING A ROLE (judge, workshop
// organizer, ...): add it to ROLES, give every level in LEVELS an entry for
// it, and create a user for it in `seed`.

// A generous budget: the matrix calls the rate-limited auth endpoints once
// per role, and they share an IP-keyed bucket (see rateLimiting.test.js).
process.env.AUTH_RATE_LIMIT_MAX = "1000";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var jwt = require("jsonwebtoken");
var mongoose = require("mongoose");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var routesHelper = require("./helpers/routes");
var app = require("../server");
var signToken = require("../utils/signToken");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var MealService = require("../schemas/mealService");
var ScheduleEvent = require("../schemas/scheduleEvent");
var Team = require("../schemas/team");
var User = require("../schemas/user");

// "none" is a request with no token at all.
var ROLES = ["none", "applicant", "moderator", "admin"];

// What each access level must answer per role: a status code, or "ok" for
// "the guard lets it through" (any answer except 401, 403 or a crash; what the
// handler does with an empty request is tested elsewhere).
var LEVELS = {
  accepted: { none: 401, applicant: 403, moderator: 403, admin: 403 },
  public: { none: "ok", applicant: "ok", moderator: "ok", admin: "ok" },
  authenticated: { none: 401, applicant: "ok", moderator: "ok", admin: "ok" },
  moderator: { none: 401, applicant: 403, moderator: "ok", admin: "ok" },
  admin: { none: 401, applicant: 403, moderator: 403, admin: "ok" },
};

/**
 * One row of the matrix.
 * @param {string} method - HTTP method.
 * @param {string} path - Route path as Express spells it, e.g. "/api/admin/rounds/:id".
 * @param {string} level - A key of LEVELS.
 * @param {object} [options]
 * @param {object} [options.use] - Which seeded document fills each :param
 *   in the side-effect pass, e.g. { id: "round" }. (The matrix pass uses
 *   made-up ids, so allowed requests can't change anything real.)
 * @param {object|function} [options.body] - A request body that would do
 *   something if the guard were missing; a function gets the seeded ids.
 * @returns {object}
 */
function row(method, path, level, options) {
  return Object.assign({ method: method, path: path, level: level }, options || {});
}

var MATRIX = [
  row("GET", "/api/admin/judging/rooms", "admin"),
  row("POST", "/api/admin/judging/rooms", "admin"),
  row("PATCH", "/api/admin/judging/rooms/:id", "admin"),
  row("DELETE", "/api/admin/judging/rooms/:id", "admin"),
  row("GET", "/api/admin/judging/projects", "admin"),
  row("PATCH", "/api/admin/judging/projects/:id", "admin"),
  row("POST", "/api/admin/judging/import", "admin"),
  row("POST", "/api/admin/judging/import/:id/confirm", "admin"),
  row("GET", "/api/workshops", "accepted"),
  row("GET", "/api/workshops/mine", "accepted"),
  row("POST", "/api/workshops/:id/signup", "accepted"),
  row("DELETE", "/api/workshops/:id/signup", "accepted"),
  row("GET", "/api/admin/workshops", "admin"),
  row("POST", "/api/admin/workshops", "admin", { body: { title: "Workshop", startsAt: "2026-10-24T12:00:00Z", endsAt: "2026-10-24T13:00:00Z" } }),
  row("PATCH", "/api/admin/workshops/:id", "admin"),
  row("DELETE", "/api/admin/workshops/:id", "admin"),
  row("GET", "/api/hardware", "authenticated"),
  row("GET", "/api/hardware/mine", "authenticated"),
  row("GET", "/api/staff/hardware", "moderator"),
  row("GET", "/api/staff/hardware/checkouts", "moderator"),
  row("POST", "/api/staff/hardware/checkouts", "moderator"),
  row("POST", "/api/staff/hardware/checkouts/:id/return", "moderator"),
  row("GET", "/api/staff/hardware/export.csv", "moderator"),
  row("POST", "/api/staff/hardware/reminders", "moderator"),
  row("GET", "/api/admin/hardware", "admin"),
  row("POST", "/api/admin/hardware/items", "admin"),
  row("PATCH", "/api/admin/hardware/items/:id", "admin"),
  row("DELETE", "/api/admin/hardware/items/:id", "admin"),
  row("POST", "/api/admin/hardware/import", "admin"),
  row("GET", "/api/admin/hardware/labels", "admin"),
  row("POST", "/api/admin/hardware/facilities", "admin"),
  row("PATCH", "/api/admin/hardware/facilities/:id", "admin"),
  row("DELETE", "/api/admin/hardware/facilities/:id", "admin"),
  // ---- Public ------------------------------------------------------------
  row("GET", "/api/health", "public"),
  row("GET", "/api/health/db", "public"),
  row("GET", "/api/meta/config", "public"),
  row("GET", "/api/meta/branding", "public"),
  row("GET", "/api/public/schedule", "public"),
  row("GET", "/api/public/schedule.ics", "public"),
  row("GET", "/api/meta/branding/files/:file", "public"),
  row("GET", "/api/meta/colleges", "public"),
  row("GET", "/api/meta/skills/programming", "public"),
  row("GET", "/api/meta/skills/hardware", "public"),
  row("GET", "/api/applications/public/round", "public"),
  row("POST", "/api/applications/public", "public"),
  row("POST", "/api/auth/register", "public"),
  row("POST", "/api/auth/login", "public"),
  row("POST", "/api/auth/forgot-password", "public"),
  row("POST", "/api/auth/reset-password", "public"),
  row("POST", "/api/auth/verify-email", "public"),
  row("POST", "/api/auth/unsubscribe", "public"),
  row("POST", "/api/auth/setup-admin", "public"),
  row("GET", "/api/auth/google", "public"),
  row("GET", "/api/auth/google/callback", "public"),

  // ---- Any logged-in user --------------------------------------------------
  row("GET", "/api/auth/me", "authenticated"),
  row("PATCH", "/api/auth/me", "authenticated"),
  row("GET", "/api/meta/links", "authenticated"),
  row("POST", "/api/auth/resend-verification", "authenticated"),
  row("POST", "/api/applications", "authenticated", { body: { name: "Sneaky" } }),
  row("GET", "/api/applications/me", "authenticated"),
  row("GET", "/api/applications/me/qr", "authenticated"),
  row("GET", "/api/applications/me/resume", "authenticated"),
  row("GET", "/api/teams/me", "authenticated"),
  row("POST", "/api/teams", "authenticated", { body: { name: "Sneaky Team" } }),
  row("PATCH", "/api/teams/me", "authenticated", { body: { name: "Renamed" } }),
  row("POST", "/api/teams/me/leave", "authenticated"),
  row("DELETE", "/api/teams/me/members/:userId", "authenticated", { use: { userId: "attendee" } }),
  row("POST", "/api/teams/me/invites", "authenticated", { body: { email: "friend@example.com" } }),
  row("DELETE", "/api/teams/me/invites/:email", "authenticated"),
  row("POST", "/api/teams/invites/:teamId/accept", "authenticated", { use: { teamId: "team" } }),
  row("POST", "/api/teams/invites/:teamId/decline", "authenticated", { use: { teamId: "team" } }),

  // ---- Moderators and admins: reviewing and event-day staff ---------------
  row("GET", "/api/admin/applications", "moderator"),
  row("GET", "/api/admin/applications/:id", "moderator", { use: { id: "application" } }),
  row("PATCH", "/api/admin/applications/:id", "moderator", {
    use: { id: "application" },
    body: { decision: "accepted" },
  }),
  row("GET", "/api/admin/applications/:id/resume", "moderator", { use: { id: "application" } }),
  row("POST", "/api/admin/applications/:id/flag", "moderator", {
    use: { id: "application" },
    body: { reason: "Matrix check" },
  }),
  row("DELETE", "/api/admin/applications/:id/flag", "moderator", { use: { id: "application" } }),
  row("GET", "/api/admin/teams", "moderator"),
  row("GET", "/api/staff/attendees", "moderator"),
  row("GET", "/api/staff/attendee", "moderator"),
  row("POST", "/api/staff/attendee/resend-qr", "moderator", {
    body: function body(ids) {
      return { email: ids.attendeeEmail };
    },
  }),
  row("POST", "/api/staff/attendee/send-account-link", "moderator", {
    body: function body(ids) {
      return { email: ids.attendeeEmail };
    },
  }),
  row("GET", "/api/staff/checkin/stats", "moderator"),
  row("GET", "/api/staff/checkin/:userId", "moderator", { use: { userId: "attendee" } }),
  row("POST", "/api/staff/checkin", "moderator", {
    body: function body(ids) {
      return { userId: ids.attendee };
    },
  }),
  row("GET", "/api/staff/meals", "moderator"),
  row("POST", "/api/staff/meals/:mealId/checkin", "moderator", {
    use: { mealId: "meal" },
    body: function body(ids) {
      return { userId: ids.attendee };
    },
  }),

  // ---- Admins only: organization setup ------------------------------------
  row("GET", "/api/admin/users", "admin"),
  row("PUT", "/api/admin/branding/:slot", "admin"),
  row("GET", "/api/admin/stats", "admin"),
  row("GET", "/api/admin/exports/applications.csv", "admin"),
  row("GET", "/api/admin/exports/checkins.csv", "admin"),
  row("GET", "/api/admin/exports/meals.csv", "admin"),
  row("GET", "/api/admin/exports/resumes.zip", "admin"),
  row("DELETE", "/api/admin/branding/:slot", "admin"),
  row("PATCH", "/api/admin/users/:id/role", "admin", { use: { id: "applicant" }, body: { role: "admin" } }),
  row("GET", "/api/admin/rounds", "admin"),
  row("POST", "/api/admin/rounds", "admin", { body: { name: "Sneaky round" } }),
  row("PATCH", "/api/admin/rounds/:id", "admin", { use: { id: "round" }, body: { name: "Renamed" } }),
  row("DELETE", "/api/admin/rounds/:id", "admin", { use: { id: "round" } }),
  row("GET", "/api/admin/email-templates", "admin"),
  row("POST", "/api/admin/email-templates", "admin", {
    body: { key: "sneaky", subject: "Hi", body: "Hi" },
  }),
  row("POST", "/api/admin/email-templates/preview", "admin", { body: { subject: "Hi", body: "Hi" } }),
  row("POST", "/api/admin/email-templates/test", "admin", { body: { subject: "Hi", body: "Hi" } }),
  row("POST", "/api/admin/email-templates/:id/test", "admin", { use: { id: "template" } }),
  row("PATCH", "/api/admin/email-templates/:id", "admin", { use: { id: "template" }, body: { subject: "Hacked" } }),
  row("DELETE", "/api/admin/email-templates/:id", "admin", { use: { id: "template" } }),
  row("GET", "/api/admin/settings", "admin"),
  row("PATCH", "/api/admin/settings", "admin", { body: { publicApplications: true } }),
  row("GET", "/api/admin/auto-accept", "admin"),
  row("POST", "/api/admin/auto-accept/preview", "admin", { body: { domains: ["example.com"] } }),
  row("GET", "/api/admin/system-config", "admin"),
  row("PATCH", "/api/admin/system-config", "admin", { body: { values: { ORG_NAME: "Hacked" } } }),
  row("POST", "/api/admin/system-config/restart", "admin"),
  row("GET", "/api/admin/meals", "admin"),
  row("POST", "/api/admin/meals", "admin", {
    body: { name: "Sneaky lunch", startsAt: "2026-10-24T12:00:00Z", endsAt: "2026-10-24T13:00:00Z" },
  }),
  row("PATCH", "/api/admin/meals/:id", "admin", { use: { id: "meal" }, body: { name: "Renamed" } }),
  row("DELETE", "/api/admin/meals/:id", "admin", { use: { id: "meal" } }),
  row("GET", "/api/admin/outbox", "admin"),
  row("GET", "/api/admin/outbox/segments", "admin"),
  row("POST", "/api/admin/outbox/bulk", "admin", {
    body: { templateKey: "application_accepted", segment: "accepted", type: "transactional" },
  }),
  row("POST", "/api/admin/outbox/resend-acceptance", "admin"),
  row("POST", "/api/admin/outbox/retry-failed", "admin"),
  row("POST", "/api/admin/outbox/cancel-queued", "admin"),
  row("GET", "/api/admin/outbox/:id", "admin"),
  row("POST", "/api/admin/outbox/:id/resend", "admin"),
  row("POST", "/api/admin/outbox/:id/cancel", "admin"),
  row("GET", "/api/admin/schedule", "admin"),
  row("POST", "/api/admin/schedule", "admin", {
    body: { title: "Sneaky event", startsAt: "2026-10-24T12:00:00Z", endsAt: "2026-10-24T13:00:00Z" },
  }),
  row("PATCH", "/api/admin/schedule/:id", "admin", { use: { id: "event" }, body: { title: "Renamed" } }),
  row("DELETE", "/api/admin/schedule/:id", "admin", { use: { id: "event" } }),
];

/**
 * Create one user per role plus the documents the side-effect pass points at.
 * @returns {Promise<object>} { users: {role: {user, token}}, ids: {...} }
 */
async function seed() {
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();

  var users = {
    applicant: await fixtures.createUser({ role: "applicant" }),
    moderator: await fixtures.createUser({ role: "moderator" }),
    admin: await fixtures.createUser({ role: "admin" }),
  };
  var attendee = await fixtures.createUser({ role: "applicant" });

  var round = await ApplicationRound.create({ name: "General", isOpen: true });
  var application = await Application.create({
    applicant: users.applicant.user._id,
    round: round._id,
    name: "Pending Applicant",
    status: "pending",
  });
  await Application.create({
    applicant: attendee.user._id,
    round: round._id,
    name: "Accepted Attendee",
    status: "accepted",
  });
  await User.ensureQrId(attendee.user._id);

  var template = await EmailTemplate.create({ key: "custom_matrix", subject: "Hello", body: "Hello" });
  var meal = await MealService.create({
    name: "Dinner",
    startsAt: new Date("2026-10-24T18:00:00Z"),
    endsAt: new Date("2026-10-24T19:00:00Z"),
    active: true,
  });
  var event = await ScheduleEvent.create({
    title: "Opening ceremony",
    startsAt: new Date("2026-10-24T10:00:00Z"),
    endsAt: new Date("2026-10-24T11:00:00Z"),
  });
  var team = await Team.create({
    name: "Real Team",
    nameKey: "real team",
    leader: attendee.user._id,
    members: [attendee.user._id],
  });

  return {
    users: users,
    ids: {
      applicant: String(users.applicant.user._id),
      attendee: String(attendee.user._id),
      attendeeEmail: attendee.user.email,
      application: String(application._id),
      round: String(round._id),
      template: String(template._id),
      meal: String(meal._id),
      event: String(event._id),
      team: String(team._id),
    },
  };
}

/**
 * Fill a route's :params. With `ids` it uses the seeded documents the row
 * names in `use`; without, every param gets a well-formed id (or email) that
 * matches nothing.
 * @param {object} r - A matrix row.
 * @param {object|null} ids - Seeded ids (the side-effect pass), or null.
 * @returns {string} The concrete path.
 */
function fillPath(r, ids) {
  return r.path.replace(/:(\w+)/g, function fill(_match, name) {
    if (ids && r.use && r.use[name]) {
      return ids[r.use[name]];
    }
    return name === "email" ? "nobody@example.com" : String(new mongoose.Types.ObjectId());
  });
}

/**
 * Send one matrix request as one role.
 * @param {object} r - A matrix row.
 * @param {string} role - One of ROLES.
 * @param {object} s - The seed (users and ids).
 * @param {boolean} real - Use seeded ids and the row's body (side-effect pass).
 * @returns {Promise<object>} The supertest response.
 */
function send(r, role, s, real) {
  var req = request(app)[r.method.toLowerCase()](fillPath(r, real ? s.ids : null));
  if (role !== "none") {
    req.set("Authorization", "Bearer " + s.users[role].token);
  }
  if (real && r.body) {
    req.send(typeof r.body === "function" ? r.body(s.ids) : r.body);
  }
  return req;
}

/**
 * Assert a response matches what the row's level promises for the role.
 * @param {object} r - A matrix row.
 * @param {string} role - One of ROLES.
 * @param {object} res - The response.
 * @returns {void}
 */
function assertDecision(r, role, res) {
  var label = r.method + " " + r.path + " as " + role;
  var want = LEVELS[r.level][role];
  if (want === "ok") {
    assert.ok(
      res.status !== 401 && res.status !== 403 && res.status !== 500,
      label + ": should be let through, got " + res.status + " " + JSON.stringify(res.body)
    );
  } else {
    assert.equal(res.status, want, label + ": expected " + want + ", got " + res.status);
  }
}

/**
 * Every collection's contents, as one string, to compare before and after.
 * @returns {Promise<string>}
 */
async function snapshotDatabase() {
  var collections = mongoose.connection.collections;
  var snapshot = {};
  for (var name of Object.keys(collections).sort()) {
    snapshot[name] = await collections[name].find({}).sort({ _id: 1 }).toArray();
  }
  return JSON.stringify(snapshot);
}

test("T12: role x route permission matrix", async function permissionMatrix(t) {
  await db.connect();
  // A public route that depends on this: it answers 409 (an admin already
  // exists) instead of 403 ("setup is disabled") only while this is on.
  process.env.SETUP_ADMIN = "true";
  var seeded = await seed();

  await t.test("every route in the matrix does what its access level promises", async function (t2) {
    // POST /email-templates/test sends mail through the (mocked) transport.
    mailMock.mockTransport(t2);

    for (var r of MATRIX) {
      var responses = await Promise.all(
        ROLES.map(function call(role) {
          return send(r, role, seeded, false);
        })
      );
      responses.forEach(function check(res, i) {
        assertDecision(r, ROLES[i], res);
      });
    }
  });

  await t.test("denied requests change nothing: no data written, no email sent", async function (t2) {
    var mail = mailMock.mockTransport(t2);
    var before = await snapshotDatabase();
    var denied = 0;

    for (var r of MATRIX) {
      for (var role of ROLES) {
        if (LEVELS[r.level][role] === "ok") {
          continue;
        }
        var res = await send(r, role, seeded, true);
        assertDecision(r, role, res);
        denied += 1;
      }
    }

    assert.ok(denied > 100, "the pass should have exercised plenty of denials, ran " + denied);
    assert.equal(await snapshotDatabase(), before, "a denied request modified the database");
    assert.equal(mail.calls.length, 0, "a denied request sent an email");
  });

  // ---- The role comes from the database, not from what a token claims ----

  await t.test("a token claiming a higher role than the account has is still refused", async function () {
    var forged = signToken({
      id: seeded.ids.applicant,
      email: seeded.users.applicant.user.email,
      role: "admin",
    });
    var res = await request(app).get("/api/admin/users").set("Authorization", "Bearer " + forged);
    assert.equal(res.status, 403);
  });

  await t.test("tokens that are expired, signed with another secret or malformed are anonymous", async function () {
    var claims = { id: seeded.ids.attendee, email: "x@example.com", role: "admin" };
    var tokens = {
      expired: jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: -60 }),
      "wrong secret": jwt.sign(claims, "not-the-secret", { expiresIn: 60 }),
      garbage: "not.a.jwt",
    };

    for (var name of Object.keys(tokens)) {
      var res = await request(app).get("/api/admin/users").set("Authorization", "Bearer " + tokens[name]);
      assert.equal(res.status, 401, name);
    }

    var noScheme = await request(app).get("/api/auth/me").set("Authorization", seeded.users.admin.token);
    assert.equal(noScheme.status, 401, "a token without the Bearer scheme is ignored");
  });

  // ---- The guard test ------------------------------------------------------

  await t.test("every mounted route is in the matrix, and the matrix has no stale rows", function () {
    var mounted = routesHelper.listRoutes(app).map(function key(route) {
      return routesHelper.routeKey(route.method, route.path);
    });
    var declared = MATRIX.map(function key(r) {
      return routesHelper.routeKey(r.method, r.path);
    });

    assert.ok(mounted.length > 40, "the router walk found only " + mounted.length + " routes");
    assert.deepEqual(
      declared.filter(function dup(k, i) {
        return declared.indexOf(k) !== i;
      }),
      [],
      "routes listed twice in the matrix"
    );
    MATRIX.forEach(function validLevel(r) {
      assert.ok(LEVELS[r.level], r.method + " " + r.path + " has an unknown level: " + r.level);
    });
    assert.deepEqual(
      mounted.filter(function missing(k) {
        return declared.indexOf(k) === -1;
      }),
      [],
      "These routes are mounted but not in the permission matrix (test/permissionMatrix.test.js). " +
        "Decide who may call each one and add a row for it."
    );
    assert.deepEqual(
      declared.filter(function stale(k) {
        return mounted.indexOf(k) === -1;
      }),
      [],
      "These matrix rows no longer match any mounted route. Remove or fix them."
    );
  });

  await db.closeDatabase();
  process.env.SETUP_ADMIN = "false";
});
