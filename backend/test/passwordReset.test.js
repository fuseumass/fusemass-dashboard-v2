"use strict";

var crypto = require("crypto");
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var User = require("../schemas/user");

// testEnv.js defaults SMTP_HOST/SMTP_USER to fake-but-truthy values so T1/T5
// can exercise mailer.sendTemplateEmail with a mocked transport. This file
// needs the opposite — the real "SMTP not configured" path — so undo that
// default here. mailer.isMailConfigured() reads process.env live on every
// call, so this takes effect regardless of require order.
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;

/**
 * Set a reset token on a user directly (mirrors what forgotPassword does),
 * so tests can control the raw token and expiry without depending on SMTP
 * or scraping console.warn for the logged link.
 * @param {object} user - A User document.
 * @param {Date} expiresAt - When the token should expire.
 * @returns {Promise<string>} The raw (unhashed) token to send to the API.
 */
function setResetToken(user, expiresAt) {
  var rawToken = crypto.randomBytes(32).toString("hex");
  user.resetPasswordToken = crypto.createHash("sha256").update(rawToken).digest("hex");
  user.resetPasswordExpires = expiresAt;
  return user.save().then(function () {
    return rawToken;
  });
}

test("T0: forgot/reset password", async function passwordReset(t) {
  await db.connect();

  await t.test("forgot-password always 200s, even for an unknown email (doesn't leak existence)", async function () {
    await db.clearDatabase();
    var res = await request(app).post("/api/auth/forgot-password").send({ email: "nobody@nowhere.com" });
    assert.equal(res.status, 200);
  });

  await t.test("forgot-password with SMTP unset doesn't fail — logs the link instead of sending", async function () {
    await db.clearDatabase();
    var applicant = await fixtures.createUser({ role: "applicant", email: "reset-me@test.com" });

    var originalWarn = console.warn;
    var warnedWith = [];
    console.warn = function (...args) {
      warnedWith.push(args.join(" "));
    };
    try {
      var res = await request(app).post("/api/auth/forgot-password").send({ email: applicant.user.email });
      assert.equal(res.status, 200);
      assert.ok(
        warnedWith.some(function (line) {
          return line.indexOf("password reset link") !== -1;
        }),
        "expected a console.warn with the reset link since SMTP isn't configured"
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  await t.test("reset-password works with a valid, unexpired token", async function () {
    await db.clearDatabase();
    var applicant = await fixtures.createUser({ role: "applicant" });
    var rawToken = await setResetToken(applicant.user, new Date(Date.now() + 60 * 60 * 1000));

    var res = await request(app).post("/api/auth/reset-password").send({ token: rawToken, password: "new-password" });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);

    var loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: applicant.user.email, password: "new-password" });
    assert.equal(loginRes.status, 200);
  });

  await t.test("reset-password rejects an expired token", async function () {
    await db.clearDatabase();
    var applicant = await fixtures.createUser({ role: "applicant" });
    var rawToken = await setResetToken(applicant.user, new Date(Date.now() - 1000)); // already expired

    var res = await request(app).post("/api/auth/reset-password").send({ token: rawToken, password: "new-password" });
    assert.equal(res.status, 400);
  });

  await t.test("reset-password token is single-use", async function () {
    await db.clearDatabase();
    var applicant = await fixtures.createUser({ role: "applicant" });
    var rawToken = await setResetToken(applicant.user, new Date(Date.now() + 60 * 60 * 1000));

    var first = await request(app).post("/api/auth/reset-password").send({ token: rawToken, password: "first-new-password" });
    assert.equal(first.status, 200);

    var second = await request(app).post("/api/auth/reset-password").send({ token: rawToken, password: "second-new-password" });
    assert.equal(second.status, 400);

    var stored = await User.findById(applicant.user._id);
    assert.equal(stored.resetPasswordToken, undefined);
  });

  await db.closeDatabase();
});
