"use strict";

// Isolated in its own file: express-rate-limit's stores are module-level and
// live for the process, so tightening the budget here would otherwise starve
// unrelated tests running alongside it.
//
// Subtest order matters. The limiters cannot be reset between subtests, and
// every supertest request arrives from the same loopback IP, so the subtest
// that needs an unspent login budget runs before the one that exhausts it.
process.env.AUTH_RATE_LIMIT_MAX = "3";
process.env.AUTH_RATE_LIMIT_WINDOW_MS = "60000";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var app = require("../server");

test("T5 + B13: auth rate limiting", async function rateLimiting(t) {
  await db.connect();
  await db.clearDatabase();

  await t.test("successful logins do not spend the login budget", async function () {
    var registered = await request(app)
      .post("/api/auth/register")
      .send({ name: "Repeat Login", email: "repeat-login@test.com", password: "secret123" });
    assert.equal(registered.status, 201);

    // More successful logins than AUTH_RATE_LIMIT_MAX. With
    // skipSuccessfulRequests they cost nothing, so none may be blocked —
    // this is what keeps a venue full of attendees behind one NAT'd IP from
    // locking itself out just by signing in.
    var statuses = [];
    for (var i = 0; i < 5; i++) {
      var res = await request(app)
        .post("/api/auth/login")
        .send({ email: "repeat-login@test.com", password: "secret123" });
      statuses.push(res.status);
    }

    assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
  });

  await t.test("failed logins are rate-limited after AUTH_RATE_LIMIT_MAX attempts, per IP", async function () {
    var statuses = [];
    for (var i = 0; i < 5; i++) {
      var res = await request(app).post("/api/auth/login").send({ email: "nobody@test.com", password: "wrong" });
      statuses.push(res.status);
    }
    // First 3 reach the controller (401 bad creds); the rest are blocked (429).
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  });

  await t.test("each endpoint keeps its own budget, so login's does not block register", async function () {
    // The previous subtest exhausted the login budget for this IP. Register
    // has its own, so it must still go through. This is the behavior change
    // from B13's review: these four endpoints used to share one bucket, which
    // meant a burst of failed logins also locked out signups and password
    // resets.
    var res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Nobody", email: "nobody2@test.com", password: "whatever" });
    assert.equal(res.status, 201);

    // ...and login is still blocked, so this is isolation rather than the
    // limiter having simply stopped working.
    var stillBlocked = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@test.com", password: "wrong" });
    assert.equal(stillBlocked.status, 429);
  });

  await t.test("forgot-password has its own budget too", async function () {
    var res = await request(app).post("/api/auth/forgot-password").send({ email: "nobody3@test.com" });
    assert.notEqual(res.status, 429);
  });

  await db.closeDatabase();
});
