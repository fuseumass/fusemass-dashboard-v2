"use strict";

// Isolated in its own file: the limiters' stores live for the whole process, so
// tightening the budget here would starve unrelated tests (see
// rateLimiting.test.js). Only the resend budget is small; sign-up keeps room.
process.env.AUTH_RATE_LIMIT_MAX = "100";
process.env.AUTH_RATE_LIMIT_MAX_RESEND_VERIFICATION = "2";
process.env.AUTH_RATE_LIMIT_WINDOW_MS = "60000";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var EmailTemplate = require("../schemas/emailTemplate");

test("B40: resending the verification email is rate limited per IP", async function resendRateLimit(t) {
  await db.connect();
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();

  await t.test("requests beyond the resend budget get 429 and the limiter's message", async function (t2) {
    var mail = mailMock.mockTransport(t2);
    var registered = await request(app)
      .post("/api/auth/register")
      .send({ name: "Ada Lovelace", email: "ada@example.com", password: "correct-horse" });
    assert.equal(registered.status, 201);
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    var auth = "Bearer " + registered.body.token;

    // The first two spend the budget (the per-account cooldown answers them,
    // since the sign-up email just went out). The third is cut off earlier, by
    // the per-IP limiter, with a different message.
    var first = await request(app).post("/api/auth/resend-verification").set("Authorization", auth);
    var second = await request(app).post("/api/auth/resend-verification").set("Authorization", auth);
    assert.equal(first.status, 429);
    assert.match(first.body.error, /wait a minute/i);
    assert.equal(second.status, 429);
    assert.match(second.body.error, /wait a minute/i);

    var third = await request(app).post("/api/auth/resend-verification").set("Authorization", auth);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, "Too many attempts. Please try again later.");
    assert.ok(third.headers["ratelimit-limit"] || third.headers["ratelimit"], "standard rate-limit headers are sent");

    assert.equal(mail.calls.length, 1, "none of the limited requests sent an email");
  });

  await t.test("the resend budget is separate from sign-up and login", async function (t2) {
    mailMock.mockTransport(t2);
    var res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Grace Hopper", email: "grace@example.com", password: "correct-horse" });
    assert.equal(res.status, 201);

    var login = await request(app).post("/api/auth/login").send({ email: "grace@example.com", password: "correct-horse" });
    assert.equal(login.status, 200);
  });

  await db.closeDatabase();
});
