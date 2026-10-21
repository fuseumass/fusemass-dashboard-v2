"use strict";

// Sign-up, resend and application-gate calls add up to more than the default
// auth budget (20 per window); the limiters themselves are covered in
// emailVerificationRateLimit.test.js.
process.env.AUTH_RATE_LIMIT_MAX = "500";

var crypto = require("crypto");
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var OrgSettings = require("../schemas/orgSettings");
var User = require("../schemas/user");
var passportUtil = require("../utils/passport");
var emailVerification = require("../utils/emailVerification");
var primaryClientOrigin = require("../utils/clientOrigin").primaryClientOrigin;

/**
 * Fresh database with the built-in email templates (verify_email among them).
 * @returns {Promise<void>}
 */
async function reset() {
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
}

/**
 * @param {string} text - An email body.
 * @returns {string|null} The raw token in its verification link.
 */
function verifyTokenFrom(text) {
  var match = /verify-email\?token=([0-9a-f]+)/.exec(text || "");
  return match ? match[1] : null;
}

/**
 * @param {string} text - An email body.
 * @returns {string|null} The raw token in its password-reset link.
 */
function resetTokenFrom(text) {
  var match = /reset-password\?token=([0-9a-f]+)/.exec(text || "");
  return match ? match[1] : null;
}

/**
 * @param {string} raw - A raw token.
 * @returns {string} Its SHA-256 hex digest, which is what the database holds.
 */
function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Register through the API and wait for the verification email to arrive.
 * @param {object} mail - The mocked transport from mailMock.mockTransport.
 * @param {string} email - Address to register.
 * @returns {Promise<{res: object, rawToken: string, jwt: string}>}
 */
async function signUp(mail, email) {
  var before = mail.calls.length;
  var res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Ada Lovelace", email: email, password: "correct-horse" });
  assert.equal(res.status, 201);

  await waitFor(function () {
    return mail.calls.length > before;
  });
  var rawToken = verifyTokenFrom(mail.calls[mail.calls.length - 1].text);
  assert.ok(rawToken, "the verification email should contain a link with a token");
  return { res: res, rawToken: rawToken, jwt: res.body.token };
}

/**
 * @param {string} rawToken - Token from an emailed link.
 * @returns {object} A pending supertest request.
 */
function verify(rawToken) {
  return request(app).post("/api/auth/verify-email").send({ token: rawToken });
}

/**
 * @param {string} jwt - A user's token.
 * @returns {object} A pending supertest request.
 */
function resend(jwt) {
  return request(app).post("/api/auth/resend-verification").set("Authorization", "Bearer " + jwt);
}

/**
 * Submit a (minimal) application for the open round.
 * @param {string} jwt - The applicant's token.
 * @param {string} status - "pending" or "draft".
 * @returns {object} A pending supertest request.
 */
function submitApplication(jwt, status) {
  return request(app)
    .post("/api/applications")
    .set("Authorization", "Bearer " + jwt)
    .field("name", "Ada Lovelace")
    .field("status", status);
}

test("B40: email verification on sign-up", async function emailVerificationSuite(t) {
  await db.connect();

  // ---- Register: real addresses only -------------------------------------

  await t.test("register rejects addresses that are not real emails", async function (t2) {
    await reset();
    mailMock.mockTransport(t2);

    var bad = ["not-an-email", "missing@tld", "@nodomain.com", "two@@example.com", "spaces in@example.com", "a@b"];
    for (var i = 0; i < bad.length; i++) {
      var res = await request(app)
        .post("/api/auth/register")
        .send({ name: "Bad Email", email: bad[i], password: "correct-horse" });
      assert.equal(res.status, 400, "expected 400 for " + JSON.stringify(bad[i]));
      assert.match(res.body.error, /valid email/i);
    }
    assert.equal(await User.countDocuments({}), 0);
  });

  await t.test("register still accepts real addresses (plus-tags, subdomains, any case)", async function (t2) {
    await reset();
    mailMock.mockTransport(t2);

    var good = ["ada+hack@example.co.uk", "Grace.Hopper@Mail.Example.COM"];
    for (var i = 0; i < good.length; i++) {
      var res = await request(app)
        .post("/api/auth/register")
        .send({ name: "Good Email", email: good[i], password: "correct-horse" });
      assert.equal(res.status, 201, "expected 201 for " + good[i]);
    }
    assert.ok(await User.findOne({ email: "grace.hopper@mail.example.com" }), "email is stored lower-cased");
  });

  // ---- Register: unverified account + emailed link -----------------------

  await t.test("register creates an unverified account and emails a single-use link; only its hash is stored", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);

    var signed = await signUp(mail, "ada@example.com");
    assert.equal(signed.res.body.user.emailVerified, false);

    var sent = mail.calls[0];
    assert.equal(sent.to, "ada@example.com");
    assert.match(sent.subject, /Verify your email for Test Org/);
    assert.ok(sent.text.indexOf(primaryClientOrigin() + "/verify-email?token=" + signed.rawToken) !== -1);
    assert.ok(sent.html.indexOf('<a href="' + primaryClientOrigin() + "/verify-email?token=" + signed.rawToken) !== -1);
    assert.match(sent.text, /24 hours/);

    var stored = await User.findOne({ email: "ada@example.com" });
    assert.equal(stored.emailVerified, false);
    assert.equal(stored.emailVerificationToken, sha256(signed.rawToken));
    assert.notEqual(stored.emailVerificationToken, signed.rawToken);

    var ttl = stored.emailVerificationExpires.getTime() - Date.now();
    assert.ok(ttl > 23.9 * 3600 * 1000 && ttl <= 24 * 3600 * 1000, "link should expire in about 24 hours, got " + ttl + "ms");
  });

  await t.test("token fields never appear in API responses", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    var signed = await signUp(mail, "ada@example.com");
    var admin = await fixtures.createUser({ role: "admin" });

    var me = await request(app).get("/api/auth/me").set("Authorization", "Bearer " + signed.jwt);
    assert.equal(me.status, 200);
    assert.equal(me.body.user.emailVerified, false);

    var users = await request(app).get("/api/admin/users?q=ada@").set("Authorization", "Bearer " + admin.token);
    assert.equal(users.status, 200);

    [JSON.stringify(signed.res.body), JSON.stringify(me.body), JSON.stringify(users.body)].forEach(function (body) {
      assert.equal(body.indexOf("emailVerificationToken"), -1);
      assert.equal(body.indexOf("emailVerificationExpires"), -1);
      assert.equal(body.indexOf("emailVerificationSentAt"), -1);
      assert.equal(body.indexOf(signed.rawToken), -1);
    });
  });

  await t.test("an unverified user can still log in, and sees the flag", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    await signUp(mail, "ada@example.com");

    var login = await request(app).post("/api/auth/login").send({ email: "ada@example.com", password: "correct-horse" });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.emailVerified, false);
  });

  await t.test("a failing mail server does not break sign-up", async function (t2) {
    await reset();
    var nodemailer = require("nodemailer");
    t2.mock.method(nodemailer, "createTransport", function () {
      return {
        sendMail: function () {
          return Promise.reject(new Error("smtp down"));
        },
      };
    });
    var errorSpy = t2.mock.method(console, "error", function () {});

    var res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Ada", email: "ada@example.com", password: "correct-horse" });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.emailVerified, false);

    // The failure is logged (after the response), not surfaced to the user.
    await waitFor(function () {
      return errorSpy.mock.callCount() >= 1;
    });
    assert.match(String(errorSpy.mock.calls[0].arguments[0]), /verification email/);
  });

  // ---- POST /api/auth/verify-email ---------------------------------------

  await t.test("verify-email verifies the account and consumes the token", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    var signed = await signUp(mail, "ada@example.com");

    var res = await verify(signed.rawToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.email, "ada@example.com");

    var stored = await User.findOne({ email: "ada@example.com" });
    assert.equal(stored.emailVerified, true);
    assert.ok(stored.emailVerifiedAt);
    assert.equal(stored.emailVerificationToken, undefined);
    assert.equal(stored.emailVerificationExpires, undefined);
    assert.equal(stored.emailVerificationSentAt, undefined);

    var again = await verify(signed.rawToken);
    assert.equal(again.status, 400, "the link works once");

    var me = await request(app).get("/api/auth/me").set("Authorization", "Bearer " + signed.jwt);
    assert.equal(me.body.user.emailVerified, true);
  });

  await t.test("verify-email works without being logged in (link opened on another device)", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    var signed = await signUp(mail, "ada@example.com");

    var res = await verify(signed.rawToken); // no Authorization header
    assert.equal(res.status, 200);
  });

  await t.test("verify-email rejects an expired link and leaves the account unverified", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    var signed = await signUp(mail, "ada@example.com");
    await User.updateOne({ email: "ada@example.com" }, { $set: { emailVerificationExpires: new Date(Date.now() - 1000) } });

    var res = await verify(signed.rawToken);
    assert.equal(res.status, 400);
    assert.equal((await User.findOne({ email: "ada@example.com" })).emailVerified, false);
  });

  await t.test("verify-email rejects unknown, empty, missing and hashed tokens", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    var signed = await signUp(mail, "ada@example.com");
    var storedHash = (await User.findOne({ email: "ada@example.com" })).emailVerificationToken;

    assert.equal((await verify(crypto.randomBytes(32).toString("hex"))).status, 400);
    assert.equal((await verify("")).status, 400);
    assert.equal((await request(app).post("/api/auth/verify-email").send({})).status, 400);
    // The stored value is a hash of the real token: leaking it must not be enough.
    assert.equal((await verify(storedHash)).status, 400);

    assert.equal((await User.findOne({ email: "ada@example.com" })).emailVerified, false);
    assert.equal((await verify(signed.rawToken)).status, 200, "the real link still works");
  });

  await t.test("two simultaneous uses of one link: exactly one succeeds", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    var signed = await signUp(mail, "ada@example.com");

    var results = await Promise.all([verify(signed.rawToken), verify(signed.rawToken)]);
    var statuses = results
      .map(function (r) {
        return r.status;
      })
      .sort();
    assert.deepEqual(statuses, [200, 400]);
  });

  // ---- Applying needs a verified email -----------------------------------

  await t.test("applying (and saving a draft) is refused until the email is verified", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    await ApplicationRound.create({ name: "General", isOpen: true });
    var signed = await signUp(mail, "ada@example.com");

    var submit = await submitApplication(signed.jwt, "pending");
    assert.equal(submit.status, 403);
    assert.equal(submit.body.code, "EMAIL_NOT_VERIFIED");
    assert.match(submit.body.error, /verify your email/i);

    var draft = await submitApplication(signed.jwt, "draft");
    assert.equal(draft.status, 403);
    assert.equal(await Application.countDocuments({}), 0);

    // The dashboard still loads for them.
    var mine = await request(app).get("/api/applications/me").set("Authorization", "Bearer " + signed.jwt);
    assert.equal(mine.status, 200);
  });

  await t.test("after verifying, the same login can apply, with no re-login", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    await ApplicationRound.create({ name: "General", isOpen: true });
    var signed = await signUp(mail, "ada@example.com");

    assert.equal((await submitApplication(signed.jwt, "pending")).status, 403);
    assert.equal((await verify(signed.rawToken)).status, 200);

    var submit = await submitApplication(signed.jwt, "pending");
    assert.equal(submit.status, 200);
    assert.equal(submit.body.application.status, "pending");

    // Let the "application received" email finish while the mock is in place.
    await waitFor(function () {
      return mail.calls.length >= 2;
    });
  });

  await t.test("a missing or invalid login still gets 401, not the verification error", async function () {
    var res = await request(app).post("/api/applications").field("name", "Nobody");
    assert.equal(res.status, 401);
  });

  // ---- POST /api/auth/resend-verification --------------------------------

  await t.test("resend needs a login", async function () {
    var res = await request(app).post("/api/auth/resend-verification");
    assert.equal(res.status, 401);
  });

  await t.test("resend sends a fresh link, replaces the old one, and is limited to one a minute per account", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    var signed = await signUp(mail, "ada@example.com");

    var tooSoon = await resend(signed.jwt);
    assert.equal(tooSoon.status, 429);
    assert.match(tooSoon.body.error, /wait a minute/i);
    assert.equal(mail.calls.length, 1, "no email for a request inside the cooldown");

    // Pretend the first email went out a while ago.
    await User.updateOne({ email: "ada@example.com" }, { $set: { emailVerificationSentAt: new Date(Date.now() - 61 * 1000) } });

    var ok = await resend(signed.jwt);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.emailVerified, false);
    await waitFor(function () {
      return mail.calls.length >= 2;
    });
    var newToken = verifyTokenFrom(mail.calls[1].text);
    assert.ok(newToken);
    assert.notEqual(newToken, signed.rawToken);
    assert.equal(mail.calls[1].to, "ada@example.com");

    var stored = await User.findOne({ email: "ada@example.com" });
    assert.equal(stored.emailVerificationToken, sha256(newToken));
    var ttl = stored.emailVerificationExpires.getTime() - Date.now();
    assert.ok(ttl > 23.9 * 3600 * 1000, "the new link gets a full 24 hours");

    assert.equal((await verify(signed.rawToken)).status, 400, "the earlier link stops working");
    assert.equal((await verify(newToken)).status, 200);
  });

  await t.test("simultaneous resends: only one email goes out", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    var signed = await signUp(mail, "ada@example.com");
    await User.updateOne({ email: "ada@example.com" }, { $set: { emailVerificationSentAt: new Date(Date.now() - 61 * 1000) } });

    var results = await Promise.all([resend(signed.jwt), resend(signed.jwt)]);
    var statuses = results
      .map(function (r) {
        return r.status;
      })
      .sort();
    assert.deepEqual(statuses, [200, 429]);
    assert.equal(mail.calls.length, 2, "the sign-up email plus exactly one resend");
  });

  await t.test("resend for an already-verified account sends nothing", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    var verified = await fixtures.createUser({ role: "applicant" });

    var res = await resend(verified.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.emailVerified, true);
    assert.equal(mail.calls.length, 0);
  });

  // ---- Existing users stay verified --------------------------------------

  await t.test("accounts created before this feature (no flag stored) count as verified and can apply", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    await ApplicationRound.create({ name: "General", isOpen: true });

    // Written straight to the collection, exactly as an old document looks:
    // none of the new fields exist.
    var passwordHash = await User.hashPassword("old-password");
    var now = new Date();
    await User.collection.insertOne({
      name: "Old Timer",
      email: "oldtimer@example.com",
      passwordHash: passwordHash,
      role: "applicant",
      createdAt: now,
      updatedAt: now,
    });
    var raw = await User.collection.findOne({ email: "oldtimer@example.com" });
    assert.equal(raw.emailVerified, undefined, "precondition: the document has no flag");

    var login = await request(app).post("/api/auth/login").send({ email: "oldtimer@example.com", password: "old-password" });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.emailVerified, true);

    var submit = await submitApplication(login.body.token, "pending");
    assert.equal(submit.status, 200, "no verification step for existing users");
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
  });

  // ---- Outgoing email not configured -------------------------------------

  await t.test("without outgoing email nothing is enforced: sign-ups start verified and can apply", async function (t2) {
    await reset();
    var savedHost = process.env.SMTP_HOST;
    var savedUser = process.env.SMTP_USER;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    t2.mock.method(console, "warn", function () {});

    try {
      await ApplicationRound.create({ name: "General", isOpen: true });
      assert.equal(emailVerification.isEnforced(), false);

      var res = await request(app)
        .post("/api/auth/register")
        .send({ name: "Dev", email: "dev@example.com", password: "correct-horse" });
      assert.equal(res.status, 201);
      assert.equal(res.body.user.emailVerified, true);

      var stored = await User.findOne({ email: "dev@example.com" });
      assert.equal(stored.emailVerificationToken, undefined);

      assert.equal((await submitApplication(res.body.token, "pending")).status, 200);

      // Even an account left unverified (made while email was on) is not
      // locked out once there is no way to deliver the link.
      var stuck = await fixtures.createUser({ role: "applicant", emailVerified: false });
      assert.equal((await submitApplication(stuck.token, "pending")).status, 200);
    } finally {
      process.env.SMTP_HOST = savedHost;
      process.env.SMTP_USER = savedUser;
    }
  });

  // ---- Setting a password through an emailed link proves the inbox -------

  await t.test("resetting a password through the emailed link verifies the account", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    var signed = await signUp(mail, "ada@example.com");

    var forgot = await request(app).post("/api/auth/forgot-password").send({ email: "ada@example.com" });
    assert.equal(forgot.status, 200);
    await waitFor(function () {
      return mail.calls.length >= 2;
    });
    var resetToken = resetTokenFrom(mail.calls[1].text);
    assert.ok(resetToken);

    var resetRes = await request(app).post("/api/auth/reset-password").send({ token: resetToken, password: "brand-new-pass" });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.body.user.emailVerified, true);

    var stored = await User.findOne({ email: "ada@example.com" });
    assert.equal(stored.emailVerified, true);
    assert.equal(stored.emailVerificationToken, undefined, "the pending verification link is dropped");
    assert.equal((await verify(signed.rawToken)).status, 400);
  });

  await t.test("someone who applied without an account becomes verified when they set a password", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    await OrgSettings.create({ key: "default", publicApplications: true });
    await ApplicationRound.create({ name: "General", isOpen: true });

    var applied = await request(app)
      .post("/api/applications/public")
      .field("email", "walkup@example.com")
      .field("name", "Walk Up");
    assert.equal(applied.status, 201);

    var created = await User.findOne({ email: "walkup@example.com" });
    assert.equal(created.emailVerified, false, "no proof of the inbox yet");
    assert.equal(created.passwordHash, undefined);
    assert.equal(created.emailVerificationToken, undefined, "no verification email: they can't log in anyway");

    await request(app).post("/api/auth/forgot-password").send({ email: "walkup@example.com" });
    await waitFor(function () {
      return mail.calls.some(function (call) {
        return resetTokenFrom(call.text);
      });
    });
    var resetCall = mail.calls.find(function (call) {
      return resetTokenFrom(call.text);
    });

    var set = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: resetTokenFrom(resetCall.text), password: "first-password" });
    assert.equal(set.status, 200);

    var after = await User.findOne({ email: "walkup@example.com" });
    assert.equal(after.emailVerified, true);
    assert.equal((await submitApplication(set.body.token, "pending")).status, 200);
  });

  // ---- Google sign-in ----------------------------------------------------

  await t.test("a new Google user is verified", async function () {
    await reset();
    var user = await passportUtil.findOrCreateGoogleUser({
      id: "g-new",
      displayName: "Grace Hopper",
      emails: [{ value: "Grace@Example.com", verified: true }],
      photos: [{ value: "https://example.com/p.png" }],
    });
    assert.equal(user.emailVerified, true);
    assert.equal(user.email, "grace@example.com");
    assert.equal(user.googleId, "g-new");
  });

  await t.test("Google verifies an unverified password account and removes the unproven password", async function (t2) {
    await reset();
    var mail = mailMock.mockTransport(t2);
    // Someone registered with an address that is not theirs.
    var signed = await signUp(mail, "victim@example.com");
    assert.equal((await request(app).post("/api/auth/login").send({ email: "victim@example.com", password: "correct-horse" })).status, 200);

    var user = await passportUtil.findOrCreateGoogleUser({
      id: "g-victim",
      displayName: "The Real Owner",
      emails: [{ value: "victim@example.com", verified: true }],
    });
    assert.equal(user.emailVerified, true);
    assert.equal(user.googleId, "g-victim");

    var stored = await User.findOne({ email: "victim@example.com" });
    assert.equal(stored.passwordHash, undefined, "the password nobody proved they should have is gone");
    assert.equal(stored.emailVerificationToken, undefined);
    var login = await request(app).post("/api/auth/login").send({ email: "victim@example.com", password: "correct-horse" });
    assert.equal(login.status, 401);
    assert.equal((await verify(signed.rawToken)).status, 400);
  });

  await t.test("Google linking leaves an already-verified account's password alone", async function () {
    await reset();
    var existing = await fixtures.createUser({ role: "applicant", email: "keeper@example.com" });

    var user = await passportUtil.findOrCreateGoogleUser({
      id: "g-keeper",
      displayName: "Keeper",
      emails: [{ value: "keeper@example.com", verified: true }],
    });
    assert.equal(String(user._id), String(existing.user._id));
    assert.equal(user.googleId, "g-keeper");
    assert.ok(user.passwordHash);
    var login = await request(app).post("/api/auth/login").send({ email: "keeper@example.com", password: "test-password" });
    assert.equal(login.status, 200);
  });

  await t.test("a Google profile whose email Google has not verified is refused", async function () {
    await reset();
    await assert.rejects(
      passportUtil.findOrCreateGoogleUser({ id: "g-bad", displayName: "Nope", emails: [{ value: "nope@example.com", verified: false }] }),
      /not verified/
    );
    await assert.rejects(passportUtil.findOrCreateGoogleUser({ id: "g-none", displayName: "None", emails: [] }), /no email/);
    assert.equal(await User.countDocuments({}), 0);
  });

  await db.closeDatabase();
});
