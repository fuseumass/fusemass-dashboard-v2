"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var app = require("../server");
var fixtures = require("./helpers/fixtures");
var User = require("../schemas/user");
var applicationStatus = require("../utils/applicationStatus");

test("validateBody: trimming and the shared status enum", async function requestValidationTests(t) {
  await db.connect();
  await db.clearDatabase();

  await t.test("a whitespace-only required string is rejected, not accepted as present", async function () {
    var res = await request(app)
      .post("/api/auth/register")
      .send({ name: "   ", email: "whitespace-name@test.com", password: "secret123" });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /name is required/);
  });

  await t.test("every required field being whitespace reports each one", async function () {
    var res = await request(app).post("/api/auth/login").send({ email: "  ", password: "\t\n " });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /email is required/);
    assert.match(res.body.error, /password is required/);
  });

  await t.test("surrounding whitespace is trimmed before the controller sees it", async function () {
    var res = await request(app)
      .post("/api/auth/register")
      .send({ name: "  Padded Name  ", email: "  padded@test.com  ", password: "secret123" });

    assert.equal(res.status, 201);

    // Stored without the padding, so later exact-match lookups can find it.
    var stored = await User.findOne({ email: "padded@test.com" });
    assert.ok(stored, "expected the trimmed email to be stored");
    assert.equal(stored.name, "Padded Name");
  });

  await t.test("a padded email can still log in, matching the trimmed record", async function () {
    var res = await request(app).post("/api/auth/login").send({ email: "  padded@test.com  ", password: "secret123" });

    assert.equal(res.status, 200);
    assert.ok(res.body.token, "expected a token for a padded but valid email");
  });

  await t.test("the decision enum still rejects a value outside DECISION_STATUSES", async function () {
    var moderator = await fixtures.createUser({ role: "moderator" });

    var res = await request(app)
      .patch("/api/admin/applications/000000000000000000000000")
      .set("Authorization", "Bearer " + moderator.token)
      .send({ decision: "draft" });

    // "draft" is a valid application status but never a reviewer decision.
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must be one of/);
    assert.equal(applicationStatus.DECISION_STATUSES.indexOf("draft"), -1);
  });

  await db.closeDatabase();
});
