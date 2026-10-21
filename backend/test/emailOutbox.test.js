"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var flaky = require("./helpers/flakyMail");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var mailer = require("../utils/mailer");
var outbox = require("../utils/outbox");
var EmailLog = require("../schemas/emailLog");
var EmailTemplate = require("../schemas/emailTemplate");
var ApplicationRound = require("../schemas/applicationRound");
var Application = require("../schemas/application");
var User = require("../schemas/user");

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
 * Make a queued row due now, as if its backoff had passed.
 * @param {*} id - EmailLog _id.
 * @returns {Promise<void>}
 */
function makeDue(id) {
  return EmailLog.updateOne({ _id: id }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
}

test("B26: email outbox log, retry and backoff", async function emailOutbox(t) {
  await db.connect();
  await EmailLog.init();

  await t.test("a successful send leaves one sent row, with no attachment or QR data in it", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var ada = await fixtures.createUser({ email: "ada@example.com", name: "Ada" });

    await mailer.sendTemplateEmail("Ada@Example.com", "application_accepted", { name: "Ada", status: "accepted" });

    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].attachments[0].cid, "checkin-qrcode", "the real email still carries the QR");

    var rows = await EmailLog.find({});
    assert.equal(rows.length, 1);
    var row = rows[0];
    assert.equal(row.to, "ada@example.com");
    assert.equal(row.templateKey, "application_accepted");
    assert.equal(row.category, "transactional");
    assert.equal(String(row.user), String(ada.user._id), "linked to the recipient's account");
    assert.equal(row.status, "sent");
    assert.equal(row.attempts, 1);
    assert.equal(row.lastError, "");
    assert.ok(row.sentAt);
    assert.equal(row.messageId, "test-1");
    assert.match(row.subject, /accepted/i);
    assert.equal(row.values.name, "Ada");

    // The QR image is drawn again from the address when needed, never stored.
    var raw = JSON.stringify(await EmailLog.collection.findOne({ _id: row._id }));
    assert.ok(raw.length < 1500, "row is small (" + raw.length + " bytes): " + raw);
    assert.doesNotMatch(raw, /attachments|image\/png|checkin-qr/);
  });

  await t.test("rows expire on their own: a TTL index on expiresAt, set ~90 days out", async function (t2) {
    await resetFixtures();
    flaky.mockFlakyTransport(t2);
    await mailer.sendTemplateEmail("ttl@example.com", "application_received", { name: "T" });

    var indexes = await EmailLog.collection.indexes();
    var ttl = indexes.find(function isTtl(index) {
      return index.key && index.key.expiresAt === 1;
    });
    assert.ok(ttl, "expiresAt index exists");
    assert.equal(ttl.expireAfterSeconds, 0);

    var row = await EmailLog.findOne({ to: "ttl@example.com" });
    var days = (row.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(days > 89 && days <= 90, "expires in about 90 days, got " + days);
  });

  await t.test("a failed send still rejects to the caller, then is retried after the backoff and sent once", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    mail.failNext(1, new Error("connect ETIMEDOUT"));

    await assert.rejects(
      mailer.sendTemplateEmail("blip@example.com", "application_received", { name: "B" }),
      /ETIMEDOUT/,
      "fire-and-forget callers still see (and log) the failure"
    );

    var row = await EmailLog.findOne({ to: "blip@example.com" });
    assert.equal(row.status, "queued");
    assert.equal(row.attempts, 1);
    assert.match(row.lastError, /ETIMEDOUT/);
    assert.ok(row.nextAttemptAt.getTime() > Date.now() + 30 * 1000, "backs off before the next try");
    assert.equal(row.lockedUntil, null);

    assert.equal(await outbox.processDue({ force: true }), 0, "not due yet");
    assert.equal(mail.calls.length, 0);

    await makeDue(row._id);
    assert.equal(await outbox.processDue({ force: true }), 1);
    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "blip@example.com");

    row = await EmailLog.findById(row._id);
    assert.equal(row.status, "sent");
    assert.equal(row.attempts, 2);
    assert.equal(row.lastError, "");

    assert.equal(await outbox.processDue({ force: true }), 0, "a sent email is never sent again");
    assert.equal(mail.calls.length, 1);
  });

  await t.test("backoff grows and it gives up as failed after the last attempt", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    mail.failNext(50, new Error("connect ETIMEDOUT"));

    await assert.rejects(mailer.sendTemplateEmail("down@example.com", "application_received", { name: "D" }));
    var row = await EmailLog.findOne({ to: "down@example.com" });
    var delays = [row.nextAttemptAt.getTime() - Date.now()];

    for (var i = 0; i < outbox.DEFAULT_MAX_ATTEMPTS - 1; i += 1) {
      await makeDue(row._id);
      await outbox.processDue({ force: true });
      row = await EmailLog.findById(row._id);
      if (row.nextAttemptAt) {
        delays.push(row.nextAttemptAt.getTime() - Date.now());
      }
    }

    assert.equal(row.status, "failed");
    assert.equal(row.attempts, outbox.DEFAULT_MAX_ATTEMPTS);
    assert.equal(row.nextAttemptAt, null);
    assert.match(row.lastError, /ETIMEDOUT/);
    assert.equal(mail.attempts, outbox.DEFAULT_MAX_ATTEMPTS);
    for (var j = 1; j < delays.length; j += 1) {
      assert.ok(delays[j] > delays[j - 1], "each wait is longer than the last: " + delays.join(", "));
    }

    // Failed rows wait for an admin; the worker leaves them alone.
    assert.equal(await outbox.processDue({ force: true }), 0);
  });

  await t.test("a permanent error (unknown mailbox) is not retried; a quota error is", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);

    mail.failNext(1, flaky.smtpError("5.1.1 The email account that you tried to reach does not exist", 550));
    await assert.rejects(mailer.sendTemplateEmail("nobody@example.com", "application_received", { name: "N" }));
    var gone = await EmailLog.findOne({ to: "nobody@example.com" });
    assert.equal(gone.status, "failed");
    assert.equal(gone.permanent, true);

    mail.failNext(1, flaky.smtpError("5.4.5 Daily user sending limit exceeded", 550));
    await assert.rejects(mailer.sendTemplateEmail("later@example.com", "application_received", { name: "L" }));
    var limited = await EmailLog.findOne({ to: "later@example.com" });
    assert.equal(limited.status, "queued", "a daily limit passes, so it is retried");
    assert.equal(limited.permanent, false);
    assert.equal(limited.attempts, 1);
  });

  await t.test("retry: false makes one attempt and no background retry", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    mail.failNext(1, new Error("connect ETIMEDOUT"));

    await assert.rejects(
      mailer.sendTemplateEmail("once@example.com", "application_received", { name: "O" }, { retry: false })
    );

    var row = await EmailLog.findOne({ to: "once@example.com" });
    assert.equal(row.status, "failed");
    assert.equal(row.attempts, 1);
    assert.equal(row.nextAttemptAt, null);
    assert.equal(await outbox.processDue({ force: true }), 0);
    assert.equal(mail.calls.length, 0);
  });

  await t.test("no double send: simultaneous claims of one row send it once", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var row = await EmailLog.create({
      to: "race@example.com",
      templateKey: "application_received",
      values: { name: "R" },
      status: "failed",
      attempts: 6,
      maxAttempts: 6,
      lastError: "earlier failure",
    });

    var results = await Promise.all([outbox.sendNow(row._id), outbox.sendNow(row._id), outbox.sendNow(row._id)]);

    var winners = results.filter(Boolean);
    assert.equal(winners.length, 1, "exactly one caller got the row");
    assert.equal(mail.calls.length, 1);
    assert.equal((await EmailLog.findById(row._id)).status, "sent");
  });

  await t.test("the worker skips a row that another attempt is already sending", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    await EmailLog.create({
      to: "held@example.com",
      templateKey: "application_received",
      values: { name: "H" },
      status: "queued",
      attempts: 1,
      maxAttempts: 6,
      nextAttemptAt: new Date(Date.now() - 1000),
      lockedUntil: new Date(Date.now() + 60 * 1000),
    });

    assert.equal(await outbox.processDue({ force: true }), 0);
    assert.equal(mail.attempts, 0);
  });

  await t.test("a send interrupted mid-flight is marked failed, not silently resent", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var row = await EmailLog.create({
      to: "crash@example.com",
      templateKey: "application_received",
      values: { name: "C" },
      status: "queued",
      attempts: 1,
      maxAttempts: 6,
      nextAttemptAt: new Date(Date.now() - 60 * 1000),
      lockedUntil: new Date(Date.now() - 1000), // the lease ran out: the process died
    });

    await outbox.processDue({ force: true });

    row = await EmailLog.findById(row._id);
    assert.equal(row.status, "failed");
    assert.equal(row.interrupted, true);
    assert.match(row.lastError, /may have been delivered/);
    assert.equal(mail.attempts, 0, "nothing was sent automatically");
  });

  await t.test("repeated SMTP failures pause the worker instead of burning every queued email's attempts", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    mail.failNext(100, new Error("connect ECONNREFUSED"));
    for (var i = 0; i < 6; i += 1) {
      await EmailLog.create({
        to: "q" + i + "@example.com",
        templateKey: "application_received",
        values: { name: "Q" },
        status: "queued",
        attempts: 0,
        maxAttempts: 6,
        nextAttemptAt: new Date(Date.now() - 1000),
      });
    }

    var attempted = await outbox.processDue();
    assert.equal(attempted, 3, "stops after three failures in a row");
    assert.equal(mail.attempts, 3);
    assert.equal(await outbox.processDue(), 0, "paused");
    assert.equal(await EmailLog.countDocuments({ status: "queued", attempts: 0 }), 3, "the rest kept their attempts");
  });

  await t.test("a missing template resolves like before, with a warning, and is recorded as failed", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var warnings = [];
    t2.mock.method(console, "warn", function (line) {
      warnings.push(String(line));
    });

    await mailer.sendTemplateEmail("x@example.com", "no_such_template", { name: "X" });

    assert.equal(mail.attempts, 0);
    assert.ok(warnings.some(function (w) { return /No email template found/.test(w); }));
    var row = await EmailLog.findOne({ to: "x@example.com" });
    assert.equal(row.status, "failed");
    assert.match(row.lastError, /no_such_template/);
    assert.equal(await outbox.processDue({ force: true }), 0, "not retried until someone creates the template");
  });

  await t.test("with email unconfigured the call resolves as before and the outbox records nothing was sent", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    t2.mock.method(console, "warn", function () {});
    var saved = process.env.SMTP_HOST;
    delete process.env.SMTP_HOST;
    try {
      await mailer.sendTemplateEmail("none@example.com", "application_received", { name: "N" });
    } finally {
      process.env.SMTP_HOST = saved;
    }

    assert.equal(mail.attempts, 0);
    var row = await EmailLog.findOne({ to: "none@example.com" });
    assert.equal(row.status, "failed");
    assert.match(row.lastError, /isn't configured/);
  });

  await t.test("if the log can't be written the email is still sent", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    t2.mock.method(console, "error", function () {});
    t2.mock.method(EmailLog, "create", function () {
      return Promise.reject(new Error("db down"));
    });

    await mailer.sendTemplateEmail("still@example.com", "application_received", { name: "S" });

    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "still@example.com");
  });

  await t.test("password reset links are logged but never stored, retried or leaked into errors", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var link = "http://localhost:3000/reset-password?token=SECRETTOKEN123";

    await mailer.sendPasswordReset("reset@example.com", link);
    assert.equal(mail.calls.length, 1);
    assert.match(mail.calls[0].text, /SECRETTOKEN123/, "the email itself has the link");

    var row = await EmailLog.findOne({ to: "reset@example.com" });
    assert.equal(row.templateKey, "password_reset");
    assert.equal(row.redacted, true);
    assert.equal(row.status, "sent");
    assert.equal(row.values, undefined);
    assert.doesNotMatch(JSON.stringify(await EmailLog.collection.findOne({ _id: row._id })), /SECRETTOKEN123/);

    mail.failNext(1, new Error("connect ETIMEDOUT"));
    await assert.rejects(mailer.sendPasswordReset("reset2@example.com", link + "&x=1"));
    var failed = await EmailLog.findOne({ to: "reset2@example.com" });
    assert.equal(failed.status, "failed", "an expired link would be useless, so no retry");
    assert.equal(failed.attempts, 1);
    assert.equal(await outbox.processDue({ force: true }), 0);
    assert.doesNotMatch(JSON.stringify(await EmailLog.collection.findOne({ _id: failed._id })), /SECRETTOKEN123/);
  });

  await t.test("account-setup emails (single-use link in the values) are stored without the link and never retried", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var link = "http://localhost:3000/reset-password?token=SETUPSECRET456&setup=1";

    mail.failNext(1, new Error("connect ETIMEDOUT"));
    await assert.rejects(
      mailer.sendTemplateEmail("setup@example.com", "account_setup", { name: "S", setupUrl: link })
    );

    var row = await EmailLog.findOne({ to: "setup@example.com" });
    assert.equal(row.redacted, true);
    assert.equal(row.status, "failed");
    assert.equal(row.values, undefined);
    assert.doesNotMatch(JSON.stringify(await EmailLog.collection.findOne({ _id: row._id })), /SETUPSECRET456/);
    assert.equal(await outbox.processDue({ force: true }), 0);

    // Any template carrying such a link is treated the same way.
    await mailer.sendTemplateEmail("other@example.com", "application_received", { name: "O", extra: link });
    var other = await EmailLog.findOne({ to: "other@example.com" });
    assert.equal(other.redacted, true);
    assert.doesNotMatch(JSON.stringify(await EmailLog.collection.findOne({ _id: other._id })), /SETUPSECRET456/);
  });

  await t.test("a calendar invite survives a retry (the check-in email)", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    mail.failNext(1, new Error("connect ETIMEDOUT"));
    var ics = { filename: "run-of-show.ics", method: "PUBLISH", content: "BEGIN:VCALENDAR\nEND:VCALENDAR" };

    await assert.rejects(
      mailer.sendTemplateEmail("cal@example.com", "checked_in", { name: "C", runOfShow: "9am: Opening" }, { icalEvent: ics })
    );
    var row = await EmailLog.findOne({ to: "cal@example.com" });
    await makeDue(row._id);
    await outbox.processDue({ force: true });

    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].icalEvent.filename, "run-of-show.ics");
    assert.match(mail.calls[0].text, /9am: Opening/);
  });

  await t.test("an acceptance email lost to an SMTP blip is sent later, QR code included", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    t2.mock.method(console, "error", function () {});
    var applicant = await fixtures.createUser({ email: "blip-accept@example.com", name: "Bea" });
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.create({ name: "R1", isOpen: true });
    var application = await Application.create({
      applicant: applicant.user._id,
      round: round._id,
      name: "Bea",
      status: "pending",
    });
    mail.failNext(1, new Error("connect ETIMEDOUT"));

    var res = await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "accepted" });
    assert.equal(res.status, 200);

    var row;
    await waitFor(function () {
      return mail.attempts >= 1;
    });
    // The failed attempt is recorded just after the response; wait for it.
    for (var i = 0; i < 100 && !(row && row.status === "queued" && row.lastError); i += 1) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 10);
      });
      row = await EmailLog.findOne({ to: "blip-accept@example.com" });
    }
    assert.equal(row.status, "queued");

    await makeDue(row._id);
    await outbox.processDue({ force: true });

    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "blip-accept@example.com");
    assert.equal(mail.calls[0].attachments[0].cid, "checkin-qrcode");
    assert.equal((await EmailLog.findById(row._id)).status, "sent");
  });

  await t.test("the retry worker runs on an interval and can be stopped", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    process.env.EMAIL_RETRY_INTERVAL_MS = "40";
    try {
      await EmailLog.create({
        to: "tick@example.com",
        templateKey: "application_received",
        values: { name: "T" },
        status: "queued",
        attempts: 1,
        maxAttempts: 6,
        nextAttemptAt: new Date(Date.now() - 1000),
      });
      outbox.startWorker();
      await waitFor(
        function () {
          return mail.calls.length === 1;
        },
        { timeoutMs: 3000 }
      );
    } finally {
      outbox.stopWorker();
      delete process.env.EMAIL_RETRY_INTERVAL_MS;
    }
    assert.equal((await EmailLog.findOne({ to: "tick@example.com" })).status, "sent");
  });

  await t.test("users and announcements: an unsubscribed recipient is skipped at send time", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var optedIn = await fixtures.createUser({ email: "in@example.com", marketingEmailConsent: true });
    var optedOut = await fixtures.createUser({ email: "out@example.com", marketingEmailConsent: false });
    await EmailTemplate.create({ key: "news", subject: "News from {{orgName}}", body: "Hi {{name}}, news!" });

    await mailer.sendTemplateEmail("in@example.com", "news", { name: "In" }, { category: "announcement" });
    await mailer.sendTemplateEmail("out@example.com", "news", { name: "Out" }, { category: "announcement" });

    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "in@example.com");
    assert.match(mail.calls[0].text, /Unsubscribe: http/);
    assert.match(mail.calls[0].html, /<a href="http[^"]+\/unsubscribe\?u=/);
    assert.match(mail.calls[0].headers["List-Unsubscribe"], /\/unsubscribe\?u=/);
    var skipped = await EmailLog.findOne({ to: "out@example.com" });
    assert.equal(skipped.status, "cancelled");
    assert.equal(String(skipped.user), String(optedOut.user._id));
    assert.ok(optedIn);
    assert.equal(await User.countDocuments({}), 2);
  });

  await db.closeDatabase();
});
