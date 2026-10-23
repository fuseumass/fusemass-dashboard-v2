"use strict";

// T15: no route may respond with secrets.
//
//   - passwordHash, resetPasswordToken and resetPasswordExpires never appear
//     in any response, under any key, however deeply nested.
//   - Nobody sees anyone else's check-in code (qrId). The code is what gets
//     a person in the door and served a meal, so it belongs to its owner: a
//     moderator or admin scans codes, they don't read them back out of the
//     API.
//
// Two kinds of checks, both against a world seeded with real secrets:
//   1. a crawl: every GET route the app mounts (found by walking the router
//      stack, so new routes are covered automatically), called as nobody, an
//      applicant, a moderator and an admin;
//   2. the flows that return user records or handle a secret (register,
//      login, password reset, role changes, check-in, teams).
// Every response is scanned for the forbidden keys and for the secret
// *values* (so a leak under a renamed key is caught too).

// The crawl and flows stay well inside the auth budget; this is for safety.
process.env.AUTH_RATE_LIMIT_MAX = "1000";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var mongoose = require("mongoose");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var routesHelper = require("./helpers/routes");
var app = require("../server");
var passwordToken = require("../utils/passwordToken");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var CheckIn = require("../schemas/checkin");
var EmailTemplate = require("../schemas/emailTemplate");
var MealService = require("../schemas/mealService");
var Team = require("../schemas/team");
var systemConfig = require("../utils/systemConfig");
var User = require("../schemas/user");

var FORBIDDEN_KEYS = [
  "passwordHash",
  "resetPasswordToken",
  "resetPasswordExpires",
  "emailVerificationToken",
  "emailVerificationExpires",
  "emailVerificationSentAt",
];

/**
 * Every key in a JSON value, with where it was found.
 * @param {*} value - Parsed JSON.
 * @param {string} path - Where `value` sits, e.g. "users[0]".
 * @param {Array<{key: string, path: string}>} out - Collected keys.
 * @returns {Array<{key: string, path: string}>}
 */
function collectKeys(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach(function each(item, i) {
      collectKeys(item, path + "[" + i + "]", out);
    });
  } else if (value && typeof value === "object") {
    Object.keys(value).forEach(function each(key) {
      out.push({ key: key, path: path + "." + key });
      collectKeys(value[key], path + "." + key, out);
    });
  }
  return out;
}

/**
 * Everything wrong with one response.
 * @param {object} res - supertest response.
 * @param {object} secrets - { passwordHashes: [], resetTokens: [], qrIds: [{userId, qrId}] }.
 * @param {string|null} callerId - The caller's user id (their own code is theirs to see).
 * @returns {string[]} Descriptions of the leaks; empty when clean.
 */
function findLeaks(res, secrets, callerId) {
  var text = res.text || "";
  var leaks = [];

  collectKeys(res.body, "body", []).forEach(function check(found) {
    if (FORBIDDEN_KEYS.indexOf(found.key) !== -1) {
      leaks.push("forbidden key " + found.path);
    }
  });
  secrets.passwordHashes.forEach(function check(hash) {
    if (text.indexOf(hash) !== -1) leaks.push("a password hash");
  });
  secrets.resetTokens.forEach(function check(token) {
    if (text.indexOf(token) !== -1) leaks.push("a password-reset token");
  });
  (secrets.configSecrets || []).forEach(function check(secret) {
    if (text.indexOf(secret) !== -1) leaks.push("a technical-settings secret");
  });
  secrets.qrIds.forEach(function check(entry) {
    if (entry.userId !== callerId && text.indexOf(entry.qrId) !== -1) {
      leaks.push("the check-in code of user " + entry.userId);
    }
  });
  return leaks;
}

/**
 * Fail with the route and who called when a response leaks.
 * @param {string} label - e.g. "GET /api/admin/users as admin".
 * @param {object} res - supertest response.
 * @param {object} world - The seeded world.
 * @param {string|null} callerId - The caller's user id.
 * @returns {void}
 */
function assertClean(label, res, world, callerId) {
  assert.deepEqual(findLeaks(res, world.secrets, callerId), [], label + " (" + res.status + ") leaked");
}

/**
 * A world with real secrets in it: a password hash on every account, check-in
 * codes for everyone, pending password-reset tokens, a team, a check-in.
 * @returns {Promise<object>}
 */
async function seed() {
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();

  var admin = await fixtures.createUser({ role: "admin", email: "admin@example.com" });
  var moderator = await fixtures.createUser({ role: "moderator", email: "moderator@example.com" });
  var alice = await fixtures.createUser({ name: "Alice", email: "alice@example.com" });
  var bob = await fixtures.createUser({ name: "Bob", email: "bob@example.com" });
  // Applied without an account: no password yet, a setup token pending.
  var carol = await fixtures.createUser({ name: "Carol", email: "carol@example.com", passwordHash: undefined });

  var round = await ApplicationRound.create({ name: "General", isOpen: true });
  var applications = {};
  for (var who of [alice, bob, carol]) {
    applications[who.user.name] = await Application.create({
      applicant: who.user._id,
      round: round._id,
      name: who.user.name,
      status: "accepted",
    });
  }

  await User.backfillQrIds();

  // Reset tokens: Alice asked for a reset, Carol has a setup link pending.
  var aliceRaw = await passwordToken.issuePasswordToken(await User.findById(alice.user._id), passwordToken.RESET_TTL_MS);
  var carolRaw = await passwordToken.issuePasswordToken(await User.findById(carol.user._id), passwordToken.SETUP_TTL_MS);

  var meal = await MealService.create({
    name: "Dinner",
    startsAt: new Date("2026-10-24T18:00:00Z"),
    endsAt: new Date("2026-10-24T19:00:00Z"),
    active: true,
  });
  await Team.create({
    name: "Real Team",
    nameKey: "real team",
    leader: alice.user._id,
    members: [alice.user._id, bob.user._id],
  });
  await CheckIn.create({ user: alice.user._id, checkedInBy: moderator.user._id });

  // Technical settings: secrets saved from the dashboard (encrypted in the
  // database) and ones that only live in the environment. None may ever show.
  var savedSecrets = {
    GOOGLE_CLIENT_SECRET: "google-secret-0123456789abcdef",
    SMTP_PASS: "smtp-pass-0123456789abcdef",
  };
  var saved = await systemConfig.applyChanges(savedSecrets, String(admin.user._id), {});
  assert.deepEqual(saved.errors, undefined);

  var everyone = await User.find({}).lean();
  var secrets = {
    configSecrets: Object.keys(savedSecrets)
      .map(function pick(key) {
        return savedSecrets[key];
      })
      .concat([process.env.JWT_SECRET]),
    passwordHashes: everyone
      .map(function pick(u) {
        return u.passwordHash;
      })
      .filter(Boolean)
      .filter(function unique(hash, i, all) {
        return all.indexOf(hash) === i;
      }),
    // What's stored (hashes of the emailed tokens) and what's emailed (raw).
    resetTokens: everyone
      .map(function pick(u) {
        return u.resetPasswordToken;
      })
      .filter(Boolean)
      .concat([aliceRaw, carolRaw]),
    qrIds: everyone.map(function pick(u) {
      return { userId: String(u._id), qrId: u.qrId };
    }),
  };

  return {
    secrets: secrets,
    callers: [
      { role: "none", token: null, id: null },
      { role: "applicant", token: alice.token, id: String(alice.user._id) },
      { role: "moderator", token: moderator.token, id: String(moderator.user._id) },
      { role: "admin", token: admin.token, id: String(admin.user._id) },
    ],
    alice: alice,
    bob: bob,
    carol: carol,
    admin: admin,
    moderator: moderator,
    ids: {
      id: String(applications.Alice._id),
      userId: String(alice.user._id),
      mealId: String(meal._id),
      teamId: String((await Team.findOne({})) ._id),
    },
  };
}

// Query strings that make a GET route return its interesting data.
var QUERIES = {
  "GET /api/staff/attendees": "?all=1",
  "GET /api/staff/attendee": "?email=alice@example.com",
  "GET /api/admin/users": "?q=example.com",
  "GET /api/meta/colleges": "?q=a",
};

/**
 * Send one request, with a token if given.
 * @param {string} method - HTTP method.
 * @param {string} path - Path (with query string).
 * @param {string|null} token - JWT, or null for anonymous.
 * @param {object} [body] - JSON body.
 * @returns {Promise<object>} supertest response.
 */
function call(method, path, token, body) {
  var req = request(app)[method.toLowerCase()](path);
  if (token) {
    req.set("Authorization", "Bearer " + token);
  }
  return body ? req.send(body) : req;
}

test("T15: responses never carry secrets", async function sensitiveFields(t) {
  await db.connect();
  await User.init();

  await t.test("the scanner itself catches planted leaks", function () {
    var secrets = { passwordHashes: ["$2a$10$hash"], resetTokens: ["abc123"], qrIds: [{ userId: "u2", qrId: "code2" }] };
    function fake(body) {
      return { body: body, text: JSON.stringify(body) };
    }
    assert.deepEqual(findLeaks(fake({ user: { name: "A" } }), secrets, "u1"), []);
    assert.equal(findLeaks(fake({ user: { passwordHash: "x" } }), secrets, "u1").length, 1);
    assert.equal(findLeaks(fake({ users: [{ nested: { resetPasswordExpires: 1 } }] }), secrets, "u1").length, 1);
    assert.equal(findLeaks(fake({ note: "hash is $2a$10$hash" }), secrets, "u1").length, 1);
    assert.equal(findLeaks(fake({ link: "?token=abc123" }), secrets, "u1").length, 1);
    assert.equal(findLeaks(fake({ code: "code2" }), secrets, "u1").length, 1, "another user's code");
    assert.deepEqual(findLeaks(fake({ code: "code2" }), secrets, "u2"), [], "your own code is yours");
  });

  await t.test("no GET route leaks, whoever calls it", async function () {
    var world = await seed();
    var routes = routesHelper.listRoutes(app).filter(function isGet(route) {
      return route.method === "GET";
    });
    assert.ok(routes.length > 20, "the router walk found only " + routes.length + " GET routes");

    var hadData = 0;
    for (var route of routes) {
      var path = route.path.replace(/:(\w+)/g, function fill(_m, name) {
        return world.ids[name] || String(new mongoose.Types.ObjectId());
      });
      var query = QUERIES["GET " + route.path] || "";
      for (var caller of world.callers) {
        var res = await call("GET", path + query, caller.token);
        assertClean("GET " + route.path + " as " + caller.role, res, world, caller.id);
        if (res.status === 200 && JSON.stringify(res.body).indexOf("alice@example.com") !== -1) {
          hadData += 1;
        }
      }
    }
    // The crawl must have actually looked at user records (the staff and
    // admin lists), not just empty or denied responses.
    assert.ok(hadData >= 5, "expected several responses to carry real user data, saw " + hadData);
  });

  await t.test("technical settings PATCH responses never carry secrets", async function () {
    var world = await seed();
    var res = await call("PATCH", "/api/admin/system-config", world.admin.token, {
      values: { SMTP_PASS: "smtp-pass-0123456789abcdef" },
    });
    assert.equal(res.status, 200);
    assertClean("PATCH /api/admin/system-config", res, world, String(world.admin.user._id));
  });

  await t.test("a user's own check-in code is shown to them, and only on their QR route", async function () {
    var world = await seed();
    var aliceId = world.callers[1].id;
    var own = world.secrets.qrIds.find(function mine(entry) {
      return entry.userId === aliceId;
    });

    var res = await call("GET", "/api/applications/me/qr", world.alice.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.qrId, own.qrId);
    assert.deepEqual(findLeaks(res, world.secrets, aliceId), []);

    // The same response is a leak for anybody else.
    assert.equal(findLeaks(res, world.secrets, "someone-else").length, 1);

    // And no other route hands the code back, even to its owner.
    var me = await call("GET", "/api/auth/me", world.alice.token);
    assert.equal(me.status, 200);
    assert.equal(JSON.stringify(me.body).indexOf(own.qrId), -1, "/api/auth/me must not include the code");
  });

  await t.test("register, login and /me return users without secrets", async function () {
    var world = await seed();

    var register = await call("POST", "/api/auth/register", null, {
      name: "Dave",
      email: "dave@example.com",
      password: "a-long-password",
    });
    assert.equal(register.status, 201);
    assertClean("register", register, world, null);

    var login = await call("POST", "/api/auth/login", null, {
      email: "alice@example.com",
      password: "test-password",
    });
    assert.equal(login.status, 200);
    assertClean("login", login, world, world.callers[1].id);

    var me = await call("GET", "/api/auth/me", login.body.token);
    assert.equal(me.status, 200);
    assertClean("/me", me, world, world.callers[1].id);
  });

  await t.test("forgot-password and reset-password never echo the token or a hash", async function (t2) {
    var world = await seed();
    var mail = mailMock.mockTransport(t2);

    var forgot = await call("POST", "/api/auth/forgot-password", null, { email: "bob@example.com" });
    assert.equal(forgot.status, 200);
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    var raw = /token=([a-f0-9]{64})/.exec(mail.calls[0].text)[1];
    var stored = (await User.findOne({ email: "bob@example.com" })).resetPasswordToken;
    world.secrets.resetTokens.push(raw, stored);
    assertClean("forgot-password", forgot, world, null);

    var reset = await call("POST", "/api/auth/reset-password", null, { token: raw, password: "brand-new-password" });
    assert.equal(reset.status, 200);
    // The reset replaced Bob's password hash: it must not come back either.
    world.secrets.passwordHashes.push((await User.findOne({ email: "bob@example.com" })).passwordHash);
    assertClean("reset-password", reset, world, String(world.bob.user._id));

    // An invalid token's error doesn't reveal anything either.
    var bad = await call("POST", "/api/auth/reset-password", null, { token: stored, password: "whatever-else" });
    assert.equal(bad.status, 400, "the stored hash is not a usable token");
    assertClean("reset-password with a bad token", bad, world, null);
  });

  await t.test("first-admin setup and role changes return users without secrets", async function () {
    var world = await seed();

    var promote = await call("PATCH", "/api/admin/users/" + world.bob.user._id + "/role", world.admin.token, {
      role: "moderator",
    });
    assert.equal(promote.status, 200);
    assertClean("PATCH role", promote, world, world.callers[3].id);

    // setup-admin only works while no admin exists: demote the admin first.
    await User.updateOne({ _id: world.admin.user._id }, { $set: { role: "applicant" } });
    process.env.SETUP_ADMIN = "true";
    try {
      var setup = await call("POST", "/api/auth/setup-admin", null, { email: "alice@example.com" });
      assert.equal(setup.status, 200);
      assert.equal(setup.body.user.role, "admin");
      assertClean("setup-admin", setup, world, null);
    } finally {
      process.env.SETUP_ADMIN = "false";
    }
  });

  await t.test("check-in, meals and attendee help don't echo codes", async function (t2) {
    var world = await seed();
    mailMock.mockTransport(t2);
    var mod = world.moderator;
    var bobCode = world.secrets.qrIds.find(function bobs(entry) {
      return entry.userId === String(world.bob.user._id);
    }).qrId;
    var modId = String(mod.user._id);

    // Scanning Bob's code, by code and then by id, repeated for the 409.
    var scan = await call("POST", "/api/staff/checkin", mod.token, { qrId: bobCode });
    assert.equal(scan.status, 201);
    assertClean("check-in by code", scan, world, modId);
    var again = await call("POST", "/api/staff/checkin", mod.token, { qrId: bobCode });
    assert.equal(again.status, 409);
    assertClean("repeat check-in", again, world, modId);

    var mealScan = await call("POST", "/api/staff/meals/" + world.ids.mealId + "/checkin", mod.token, {
      qrId: bobCode,
    });
    assert.equal(mealScan.status, 201);
    assertClean("meal check-in", mealScan, world, modId);

    var lookup = await call("GET", "/api/staff/attendee?email=bob@example.com", mod.token);
    assert.equal(lookup.status, 200);
    assertClean("attendee lookup", lookup, world, modId);

    var accountLink = await call("POST", "/api/staff/attendee/send-account-link", mod.token, {
      email: "carol@example.com",
    });
    assert.equal(accountLink.status, 200);
    // That issued a new token for Carol: it must not be in the response.
    world.secrets.resetTokens.push((await User.findOne({ email: "carol@example.com" })).resetPasswordToken);
    assertClean("send-account-link", accountLink, world, modId);

    var unknown = await call("POST", "/api/staff/checkin", mod.token, { qrId: "f".repeat(64) });
    assert.equal(unknown.status, 404);
    assertClean("unknown code", unknown, world, modId);
  });

  await t.test("teams show members' names and emails only", async function (t2) {
    var world = await seed();
    mailMock.mockTransport(t2); // an invite emails the invitee
    var aliceId = world.callers[1].id;

    var mine = await call("GET", "/api/teams/me", world.alice.token);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.team.members.length, 2, "Bob is on Alice's team");
    assertClean("GET /api/teams/me", mine, world, aliceId);

    var invite = await call("POST", "/api/teams/me/invites", world.alice.token, { email: "carol@example.com" });
    assert.equal(invite.status, 201);
    assertClean("team invite", invite, world, aliceId);

    var all = await call("GET", "/api/admin/teams", world.moderator.token);
    assert.equal(all.status, 200);
    assertClean("GET /api/admin/teams", all, world, world.callers[2].id);
  });

  await db.closeDatabase();
});
