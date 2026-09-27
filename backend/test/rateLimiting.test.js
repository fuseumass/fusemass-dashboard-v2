"use strict";

// Isolated in its own file: express-rate-limit's in-memory store is shared
// across every route authRateLimit is mounted on (one IP-keyed budget for
// login/register/forgot-password/setup-admin combined, by design — a
// stronger brute-force defense than a per-route budget), so tightening it
// here would otherwise starve unrelated tests running in the same process.
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

  await t.test("login is rate-limited after AUTH_RATE_LIMIT_MAX attempts, per IP", async function () {
    var statuses = [];
    for (var i = 0; i < 5; i++) {
      var res = await request(app).post("/api/auth/login").send({ email: "nobody@test.com", password: "wrong" });
      statuses.push(res.status);
    }
    // First 3 reach the controller (401 bad creds); the rest are blocked (429).
    assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  });

  await t.test("the budget is shared across auth endpoints, not per-route", async function () {
    // The previous subtest already exhausted this IP's budget.
    var res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Nobody", email: "nobody2@test.com", password: "whatever" });
    assert.equal(res.status, 429);
  });

  await db.closeDatabase();
});
