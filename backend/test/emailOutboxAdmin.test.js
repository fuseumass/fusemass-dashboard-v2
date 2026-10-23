"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("crypto");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var flaky = require("./helpers/flakyMail");
var app = require("../server");
var mailer = require("../utils/mailer");
var outbox = require("../utils/outbox");
var EmailLog = require("../schemas/emailLog");
var EmailTemplate = require("../schemas/emailTemplate");
var ApplicationRound = require("../schemas/applicationRound");
var Application = require("../schemas/application");
var User = require("../schemas/user");

/**
 * @param {object} who - {token} from fixtures.createUser.
 * @returns {object} Header object for supertest .set().
 */
function as(who) {
  return { Authorization: "Bearer " + who.token };
}

/**
 * Fresh DB + seeded templates + no remembered failures before every subtest.
 * @returns {Promise<void>}
 */
function resetFixtures() {
  outbox.resetBreaker();
  return db.clearDatabase().then(function afterClear() {
    return EmailTemplate.seedDefaults();
  });
}

/**
 * Write a failed row, as if three earlier attempts had given up.
 * @param {string} to - Recipient.
 * @param {object} [extra] - Fields to override.
 * @returns {Promise<object>} The EmailLog document.
 */
function failedRow(to, extra) {
  return EmailLog.create(
    Object.assign(
      {
        to: to,
        templateKey: "application_received",
        values: { name: "Pat", status: "pending" },
        status: "failed",
        attempts: 6,
        maxAttempts: 6,
        lastError: "connect ETIMEDOUT",
      },
      extra || {}
    )
  );
}

test("B26: admin outbox API", async function adminOutbox(t) {
  await db.connect();

  await t.test("only admins can use it", async function () {
    await resetFixtures();
    var moderator = await fixtures.createUser({ role: "moderator" });
    var applicant = await fixtures.createUser({ role: "applicant" });

    assert.equal((await request(app).get("/api/admin/outbox")).status, 401);
    assert.equal((await request(app).get("/api/admin/outbox").set(as(moderator))).status, 403);
    assert.equal((await request(app).get("/api/admin/outbox").set(as(applicant))).status, 403);
    assert.equal((await request(app).post("/api/admin/outbox/bulk").set(as(moderator)).send({})).status, 403);
    assert.equal((await request(app).post("/api/admin/outbox/resend-acceptance").set(as(moderator))).status, 403);
    assert.equal((await request(app).post("/api/admin/outbox/retry-failed").set(as(applicant))).status, 403);
  });

  await t.test("lists newest first, filters by status, template and address, with counts", async function (t2) {
    await resetFixtures();
    flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    await mailer.sendTemplateEmail("ok@example.com", "application_received", { name: "Ok" });
    await failedRow("bad@example.com");
    await failedRow("worse@example.com", { templateKey: "checked_in" });
    await EmailLog.create({
      to: "wait@example.com",
      templateKey: "application_received",
      status: "queued",
      attempts: 2,
      nextAttemptAt: new Date(Date.now() + 60000),
      lastError: "connect ETIMEDOUT",
    });

    var all = await request(app).get("/api/admin/outbox").set(as(admin));
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 4);
    assert.deepEqual(all.body.counts, { queued: 1, retrying: 1, sent: 1, failed: 2, cancelled: 0 });
    assert.equal(all.body.smtpConfigured, true);
    assert.equal(all.body.dailyLimit, 500);
    assert.equal(all.body.committedLast24h, 2, "one sent + one waiting");
    assert.equal(all.body.emails[0].to, "wait@example.com", "newest first");
    assert.equal(all.body.emails[0].options, undefined);

    var failed = await request(app).get("/api/admin/outbox?status=failed").set(as(admin));
    assert.deepEqual(failed.body.emails.map(function (e) { return e.to; }).sort(), ["bad@example.com", "worse@example.com"]);
    assert.equal(failed.body.emails[0].resendMode, "retry");

    var retrying = await request(app).get("/api/admin/outbox?status=retrying").set(as(admin));
    assert.deepEqual(retrying.body.emails.map(function (e) { return e.to; }), ["wait@example.com"]);

    var byTemplate = await request(app).get("/api/admin/outbox?template=checked_in").set(as(admin));
    assert.equal(byTemplate.body.total, 1);

    var byAddress = await request(app).get("/api/admin/outbox?q=OK@").set(as(admin));
    assert.equal(byAddress.body.total, 1);
    assert.equal(byAddress.body.emails[0].status, "sent");
    // Regex characters in the search are plain text.
    assert.equal((await request(app).get("/api/admin/outbox?q=.*").set(as(admin))).body.total, 0);

    var paged = await request(app).get("/api/admin/outbox?limit=2&page=2").set(as(admin));
    assert.equal(paged.body.emails.length, 2);
    assert.equal(paged.body.total, 4);
  });

  await t.test("one row by id; unknown or malformed ids are 404", async function () {
    await resetFixtures();
    var admin = await fixtures.createUser({ role: "admin" });
    var row = await failedRow("one@example.com");

    var found = await request(app).get("/api/admin/outbox/" + row._id).set(as(admin));
    assert.equal(found.status, 200);
    assert.equal(found.body.email.values.name, "Pat");
    assert.equal(
      (await request(app).get("/api/admin/outbox/" + new (require("mongoose").Types.ObjectId)()).set(as(admin))).status,
      404
    );
    assert.equal((await request(app).get("/api/admin/outbox/nope").set(as(admin))).status, 404);
  });

  await t.test("resend a failed email: sent once, the same row becomes sent", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var row = await failedRow("pat@example.com");

    var res = await request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.delivered, true);
    assert.equal(res.body.email.status, "sent");
    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "pat@example.com");
    assert.match(mail.calls[0].text, /Pat/, "re-rendered from the stored values");
    assert.equal(await EmailLog.countDocuments({}), 1, "retried in place, no duplicate row");
  });

  await t.test("a double-clicked resend sends one email", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var row = await failedRow("dbl@example.com");

    var responses = await Promise.all([
      request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin)),
      request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin)),
      request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin)),
    ]);

    var statuses = responses.map(function (r) { return r.status; }).sort();
    assert.equal(mail.calls.length, 1);
    assert.equal(statuses.filter(function (s) { return s === 200; }).length, 1, statuses.join(","));
    assert.ok(statuses.every(function (s) { return s === 200 || s === 409; }), statuses.join(","));
  });

  await t.test("a resend that fails again says why (502) and keeps the row for the next retry", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var row = await failedRow("still@example.com");
    mail.failNext(1, new Error("connect ETIMEDOUT"));

    var res = await request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin));

    assert.equal(res.status, 502);
    assert.match(res.body.error, /ETIMEDOUT/);
    assert.equal(res.body.delivered, false);
    assert.equal(res.body.email.status, "queued", "back in the queue with a new backoff");
    assert.equal(res.body.email.attempts, 1);
  });

  await t.test("a sent email is only sent again on request, as a new row, and not twice at once", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    await mailer.sendTemplateEmail("lost@example.com", "application_received", { name: "Lou" });
    var row = await EmailLog.findOne({ to: "lost@example.com" });
    assert.equal(
      (await request(app).get("/api/admin/outbox/" + row._id).set(as(admin))).body.email.resendMode,
      "again"
    );

    var plain = await request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin));
    assert.equal(plain.status, 409);
    assert.equal(plain.body.code, "ALREADY_SENT");
    assert.equal(mail.calls.length, 1);

    var responses = await Promise.all([
      request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin)).send({ again: true }),
      request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin)).send({ again: true }),
    ]);
    var ok = responses.filter(function (r) { return r.status === 200; });
    assert.equal(ok.length, 1, "a double click sends one more copy, not two");
    assert.equal(mail.calls.length, 2);
    assert.equal(ok[0].body.email.resendOf, String(row._id));
    assert.equal(await EmailLog.countDocuments({}), 2);
  });

  await t.test("a password-reset email can't be resent from the outbox", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    await mailer.sendPasswordReset("forgot@example.com", "http://localhost:3000/reset-password?token=abc");
    var row = await EmailLog.findOne({ to: "forgot@example.com" });

    var res = await request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin)).send({ again: true });

    assert.equal(res.status, 409);
    assert.match(res.body.error, /Forgot password|fresh link/);
    assert.equal(mail.calls.length, 1, "only the original");
  });

  await t.test("a failed account-setup email is re-issued with a new link, never the old one", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var grace = await fixtures.createUser({ email: "grace@example.com", name: "Grace", passwordHash: undefined });
    var oldLink = "http://localhost:3000/reset-password?token=" + "a".repeat(64) + "&setup=1";
    mail.failNext(1, new Error("connect ETIMEDOUT"));
    await assert.rejects(mailer.sendTemplateEmail("grace@example.com", "account_setup", { name: "Grace", setupUrl: oldLink }));
    var row = await EmailLog.findOne({ to: "grace@example.com" });
    assert.equal(
      (await request(app).get("/api/admin/outbox/" + row._id).set(as(admin))).body.email.resendMode,
      "reissue"
    );

    var res = await request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin));

    assert.equal(res.status, 200);
    assert.equal(mail.calls.length, 1);
    var match = /reset-password\?token=([0-9a-f]+)&setup=1/.exec(mail.calls[0].text);
    assert.ok(match, "the email has a setup link");
    assert.notEqual(match[1], "a".repeat(64), "a new token, not the lost one");
    var stored = await User.findById(grace.user._id);
    assert.equal(stored.resetPasswordToken, crypto.createHash("sha256").update(match[1]).digest("hex"));
    assert.ok(stored.resetPasswordExpires.getTime() > Date.now() + 6 * 24 * 60 * 60 * 1000, "a fresh 7-day link");

    assert.equal((await EmailLog.findById(row._id)).status, "cancelled", "the dead row leaves the failures list");
    var rows = await EmailLog.collection.find({}).toArray();
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(match[1]), "the new token isn't stored either");
  });

  await t.test("an account-setup resend refuses once they have a password", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    await fixtures.createUser({ email: "done@example.com" }); // has a password
    var row = await failedRow("done@example.com", { templateKey: "account_setup", redacted: true, values: undefined });

    var res = await request(app).post("/api/admin/outbox/" + row._id + "/resend").set(as(admin));

    assert.equal(res.status, 409);
    assert.match(res.body.error, /already set a password/);
    assert.equal(mail.calls.length, 0);
  });

  await t.test("resend answers 503 when email isn't configured, and 409 for cancelled rows", async function (t2) {
    await resetFixtures();
    flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var cancelled = await failedRow("c@example.com", { status: "cancelled" });

    var denied = await request(app).post("/api/admin/outbox/" + cancelled._id + "/resend").set(as(admin));
    assert.equal(denied.status, 409);

    var saved = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      var res = await request(app).post("/api/admin/outbox/" + cancelled._id + "/resend").set(as(admin));
      assert.equal(res.status, 503);
    } finally {
      process.env.SMTP_HOST = saved;
    }
  });

  await t.test("cancel stops a waiting email; sent ones can't be cancelled", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var waiting = await EmailLog.create({
      to: "w@example.com",
      templateKey: "application_received",
      values: { name: "W" },
      status: "queued",
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1000),
    });
    var sent = await failedRow("s@example.com", { status: "sent" });

    var res = await request(app).post("/api/admin/outbox/" + waiting._id + "/cancel").set(as(admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.email.status, "cancelled");
    assert.equal(await outbox.processDue({ force: true }), 0);
    assert.equal(mail.attempts, 0);

    assert.equal((await request(app).post("/api/admin/outbox/" + sent._id + "/cancel").set(as(admin))).status, 409);
    assert.equal((await request(app).post("/api/admin/outbox/" + waiting._id + "/cancel").set(as(admin))).status, 409);
  });

  await t.test("retry all failed: requeues the worthwhile ones, skips permanent and interrupted, reissues setup links", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    await failedRow("a@example.com");
    await failedRow("b@example.com");
    await failedRow("perm@example.com", { permanent: true });
    await failedRow("crash@example.com", { interrupted: true });
    await failedRow("link@example.com", { templateKey: "account_setup", redacted: true, values: undefined });

    var dry = await request(app).post("/api/admin/outbox/retry-failed").set(as(admin)).send({ dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.wouldRequeue, 2);
    assert.equal(dry.body.wouldReissue, 1);
    assert.equal(mail.attempts, 0);

    var res = await request(app).post("/api/admin/outbox/retry-failed").set(as(admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.requeued, 2);
    // link@example.com has no account, so there's no link to reissue: the
    // row leaves the failures list instead.
    assert.equal(res.body.reissued, 0);

    await outbox.processDue({ force: true });
    assert.deepEqual(
      mail.calls.map(function (c) { return c.to; }).sort(),
      ["a@example.com", "b@example.com"]
    );
    assert.equal(await EmailLog.countDocuments({ status: "failed" }), 2);
  });

  await t.test("retry all failed sends a fresh setup link for a setup email that failed for a temporary reason", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var ada = await fixtures.createUser({ email: "ada@example.com", name: "Ada", passwordHash: undefined });
    var row = await failedRow("ada@example.com", {
      templateKey: "account_setup",
      redacted: true,
      values: undefined,
      user: ada.user._id,
      lastError: "452 4.3.1 Rate limit exceeded, retry after 2 seconds",
    });
    await failedRow("gone@example.com", { templateKey: "account_setup", redacted: true, values: undefined, permanent: true });

    var res = await request(app).post("/api/admin/outbox/retry-failed").set(as(admin));

    assert.equal(res.status, 200);
    assert.equal(res.body.reissued, 1);
    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "ada@example.com");
    assert.match(mail.calls[0].text, /reset-password\?token=[0-9a-f]+&setup=1/);
    assert.equal((await EmailLog.findById(row._id)).status, "cancelled");
    assert.equal(await EmailLog.countDocuments({ status: "failed", to: "gone@example.com" }), 1, "permanent failures stay");
  });

  await t.test("retry all failed refuses to blow through the daily sending limit unless told to", async function (t2) {
    await resetFixtures();
    flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    await failedRow("a@example.com");
    await failedRow("b@example.com");
    process.env.EMAIL_DAILY_LIMIT = "1";
    try {
      var blocked = await request(app).post("/api/admin/outbox/retry-failed").set(as(admin));
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, "OVER_DAILY_LIMIT");
      assert.equal(await EmailLog.countDocuments({ status: "failed" }), 2);

      var forced = await request(app)
        .post("/api/admin/outbox/retry-failed")
        .set(as(admin))
        .send({ allowOverLimit: true });
      assert.equal(forced.status, 200);
      assert.equal(forced.body.requeued, 2);
      await outbox.processDue({ force: true });
    } finally {
      delete process.env.EMAIL_DAILY_LIMIT;
    }
  });

  await t.test("staff who await a resend still see failures, and it isn't also retried behind their back", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    t2.mock.method(console, "error", function () {});
    var moderator = await fixtures.createUser({ role: "moderator" });
    var ada = await fixtures.createUser({ email: "ada@example.com", name: "Ada" });
    var round = await ApplicationRound.create({ name: "R", isOpen: true });
    await Application.create({ applicant: ada.user._id, round: round._id, name: "Ada", status: "accepted" });
    mail.failNext(1, new Error("connect ETIMEDOUT"));

    var res = await request(app)
      .post("/api/staff/attendee/resend-qr")
      .set(as(moderator))
      .send({ email: "ada@example.com" });

    assert.equal(res.status, 500, "the staff member is told it failed, as before");
    var row = await EmailLog.findOne({ to: "ada@example.com" });
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 1);
    assert.equal(String(row.requestedBy), String(moderator.user._id));
    assert.equal(await outbox.processDue({ force: true }), 0, "no silent second send");

    var again = await request(app)
      .post("/api/staff/attendee/resend-qr")
      .set(as(moderator))
      .send({ email: "ada@example.com" });
    assert.equal(again.status, 200);
    assert.equal(mail.calls.length, 1);
  });

  await db.closeDatabase();
});
