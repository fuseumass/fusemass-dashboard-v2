"use strict";

// Generous budget: this file makes more auth-endpoint calls than B13's
// default (20) comfortably allows across register/login/setup-admin
// combined (they share one IP-keyed bucket — see rateLimiting.test.js).
process.env.AUTH_RATE_LIMIT_MAX = "100";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");

test("T0: register/login/me + JWT, role guards, first-admin bootstrap", async function authAndGuards(t) {
  await db.connect();

  // ---- Register / login / me / JWT ---------------------------------------

  await t.test("register creates an applicant and returns a working JWT", async function () {
    await db.clearDatabase();

    var registerRes = await request(app)
      .post("/api/auth/register")
      .send({ name: "Alex Applicant", email: "alex@test.com", password: "hunter2" });
    assert.equal(registerRes.status, 201);
    assert.equal(registerRes.body.user.role, "applicant");
    assert.ok(registerRes.body.token);

    var meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer " + registerRes.body.token);
    assert.equal(meRes.status, 200);
    assert.equal(meRes.body.user.email, "alex@test.com");
  });

  await t.test("register rejects a duplicate email", async function () {
    await db.clearDatabase();
    await request(app)
      .post("/api/auth/register")
      .send({ name: "First", email: "dup@test.com", password: "hunter2" });

    var res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Second", email: "dup@test.com", password: "hunter2" });
    assert.equal(res.status, 409);
  });

  await t.test("login works with the right password, fails with the wrong one", async function () {
    await db.clearDatabase();
    await request(app)
      .post("/api/auth/register")
      .send({ name: "Alex", email: "login-test@test.com", password: "correct-password" });

    var goodLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "login-test@test.com", password: "correct-password" });
    assert.equal(goodLogin.status, 200);
    assert.ok(goodLogin.body.token);

    var badLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: "login-test@test.com", password: "wrong-password" });
    assert.equal(badLogin.status, 401);
  });

  await t.test("/api/auth/me with no token is 401", async function () {
    var res = await request(app).get("/api/auth/me");
    assert.equal(res.status, 401);
  });

  // ---- Role guards --------------------------------------------------------

  await t.test("isAuthenticated: unauthenticated request to a protected route is 401", async function () {
    var res = await request(app).get("/api/applications/me");
    assert.equal(res.status, 401);
  });

  await t.test("isModerator: an applicant gets 403 on a moderator route", async function () {
    await db.clearDatabase();
    var applicant = await fixtures.createUser({ role: "applicant" });
    var res = await request(app)
      .get("/api/admin/applications")
      .set("Authorization", "Bearer " + applicant.token);
    assert.equal(res.status, 403);
  });

  await t.test("isModerator: a moderator is let through", async function () {
    await db.clearDatabase();
    var moderator = await fixtures.createUser({ role: "moderator" });
    var res = await request(app)
      .get("/api/admin/applications")
      .set("Authorization", "Bearer " + moderator.token);
    assert.equal(res.status, 200);
  });

  await t.test("isAdmin: a moderator gets 403 on an admin-only route", async function () {
    await db.clearDatabase();
    var moderator = await fixtures.createUser({ role: "moderator" });
    var res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", "Bearer " + moderator.token);
    assert.equal(res.status, 403);
  });

  await t.test("isAdmin: an admin is let through", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", "Bearer " + admin.token);
    assert.equal(res.status, 200);
  });

  // ---- First-admin bootstrap ----------------------------------------------

  await t.test("setup-admin: disabled (SETUP_ADMIN=false) refuses even a valid request", async function () {
    await db.clearDatabase();
    await fixtures.createUser({ email: "bootstrap-target@test.com", role: "applicant" });
    process.env.SETUP_ADMIN = "false";

    var res = await request(app).post("/api/auth/setup-admin").send({ email: "bootstrap-target@test.com" });
    assert.equal(res.status, 403);
  });

  await t.test("setup-admin: enabled promotes the named user, then refuses once an admin exists", async function () {
    await db.clearDatabase();
    await fixtures.createUser({ email: "bootstrap-target2@test.com", role: "applicant" });
    process.env.SETUP_ADMIN = "true";

    var firstPromote = await request(app).post("/api/auth/setup-admin").send({ email: "bootstrap-target2@test.com" });
    assert.equal(firstPromote.status, 200);
    assert.equal(firstPromote.body.user.role, "admin");

    // A second target exists, but an admin now does too — must be refused.
    await fixtures.createUser({ email: "bootstrap-target3@test.com", role: "applicant" });
    var secondPromote = await request(app).post("/api/auth/setup-admin").send({ email: "bootstrap-target3@test.com" });
    assert.equal(secondPromote.status, 409);

    process.env.SETUP_ADMIN = "false";
  });

  await db.closeDatabase();
});
