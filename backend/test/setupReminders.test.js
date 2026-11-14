"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var app = require("../server");
var setupReminders = require("../utils/setupReminders");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailLog = require("../schemas/emailLog");
var EmailTemplate = require("../schemas/emailTemplate");
var User = require("../schemas/user");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

async function seed() {
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
  var round = await ApplicationRound.create({ name: "Fall", isOpen: true });
  var people = {};
  async function person(key, status, fields) {
    var who = await fixtures.createUser(Object.assign({ role: "applicant", email: key + "@example.com", name: key }, fields || {}));
    await Application.create({ applicant: who.user._id, round: round._id, name: key, status: status });
    people[key] = who;
  }
  await person("noPass1", "accepted", { passwordHash: undefined });
  await person("noPass2", "accepted", { passwordHash: undefined });
  await person("google", "accepted", { passwordHash: undefined, googleId: "g-1" });
  await person("withPass", "accepted");
  await person("pendingNoPass", "pending", { passwordHash: undefined });
  await person("recent", "accepted", { passwordHash: undefined, setupReminderSentAt: new Date(Date.now() - 60 * 60 * 1000) });
  await person("old", "accepted", { passwordHash: undefined, setupReminderSentAt: new Date(Date.now() - 30 * 60 * 60 * 1000) });
  people.admin = await fixtures.createUser({ role: "admin" });
  people.mod = await fixtures.createUser({ role: "moderator" });
  return people;
}

test("account setup reminders", async function (t) {
  await db.connect();

  await t.test("admins only", async function () {
    var p = await seed();
    assert.equal((await request(app).get("/api/admin/setup-reminders").set(as(p.mod))).status, 403);
    assert.equal((await request(app).post("/api/admin/setup-reminders").set(as(p.mod))).status, 403);
    assert.equal((await request(app).post("/api/admin/setup-reminders")).status, 401);
  });

  await t.test("counts only accepted people who can't sign in, minus the last 24 hours", async function () {
    var p = await seed();
    var res = await request(app).get("/api/admin/setup-reminders").set(as(p.admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.needSetup, 4, "noPass1, noPass2, recent, old");
    assert.equal(res.body.eligible, 3);
    assert.equal(res.body.skippedRecent, 1);
  });

  await t.test("sends fresh links, records the time, and never twice in 24 hours", async function (t2) {
    var mail = mailMock.mockTransport(t2);
    var p = await seed();
    var res = await request(app).post("/api/admin/setup-reminders").set(as(p.admin)).send({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.queued, 3);
    assert.equal(res.body.skippedRecent, 1);
    assert.equal(res.body.deferredByLimit, 0);
    await setupReminders.idle();

    var to = mail.calls
      .map(function addr(c) {
        return c.to;
      })
      .sort();
    assert.deepEqual(to, ["noPass1@example.com", "noPass2@example.com", "old@example.com"].map(function l(e) { return e.toLowerCase(); }).sort());
    mail.calls.forEach(function link(c) {
      assert.match(c.text, /\/reset-password\?token=[a-f0-9]{64}&setup=1/);
    });
    var reminded = await User.findOne({ email: "nopass1@example.com" });
    assert.ok(reminded.resetPasswordToken, "a fresh token was issued");
    assert.ok(reminded.resetPasswordExpires > new Date(Date.now() + 6 * 24 * 60 * 60 * 1000), "7-day link");
    assert.ok(reminded.setupReminderSentAt > new Date(Date.now() - 60000));
    var untouched = await User.findOne({ email: "pendingnopass@example.com" });
    assert.equal(untouched.resetPasswordToken, undefined);

    var rows = await EmailLog.find({ templateKey: "account_setup_reminder" });
    assert.equal(rows.length, 3);
    rows.forEach(function redacted(row) {
      assert.equal(row.redacted, true, "the single-use link isn't stored");
    });

    var again = await request(app).post("/api/admin/setup-reminders").set(as(p.admin)).send({});
    assert.equal(again.body.queued, 0);
    assert.equal(again.body.skippedRecent, 4);
    await setupReminders.idle();
    assert.equal(mail.calls.length, 3);

    // A concurrent claim for someone already reminded does nothing.
    assert.equal(await setupReminders.remindOne(reminded._id, p.admin.user._id), false);
  });

  await t.test("a failed send is retried with a fresh link, and skipped once it isn't needed", async function (t2) {
    var nodemailer = require("nodemailer");
    var outbox = require("../utils/outbox");
    var failing = true;
    var sent = [];
    t2.mock.method(nodemailer, "createTransport", function transport() {
      return {
        sendMail: function sendMail(options) {
          if (failing) {
            return Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" }));
          }
          sent.push(options);
          return Promise.resolve({ messageId: "retry-" + sent.length });
        },
      };
    });
    var p = await seed();
    var res = await request(app).post("/api/admin/setup-reminders").set(as(p.admin)).send({});
    assert.equal(res.body.queued, 3);
    await setupReminders.idle();

    var user = await User.findOne({ email: "nopass1@example.com" });
    assert.ok(user.setupReminderSentAt, "the claim is kept, so the next run doesn't remind them twice");
    var firstToken = user.resetPasswordToken;
    var row = await EmailLog.findOne({ to: "nopass1@example.com", templateKey: "account_setup_reminder" });
    assert.equal(row.status, "queued", "queued for a retry");
    assert.equal(row.maxAttempts, 6);
    assert.equal(row.redacted, true, "the link itself is never stored");
    assert.equal(row.values, undefined);

    failing = false;
    outbox.resetBreaker();
    var after = await outbox.sendNow(row._id);
    assert.equal(after.status, "sent");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /reset-password\?token=[a-f0-9]+&setup=1/);
    user = await User.findOne({ email: "nopass1@example.com" });
    assert.notEqual(user.resetPasswordToken, firstToken, "the retry issued a fresh link");

    var row2 = await EmailLog.findOne({ to: "nopass2@example.com", templateKey: "account_setup_reminder" });
    await User.updateOne({ email: "nopass2@example.com" }, { $set: { passwordHash: "set-meanwhile" } });
    var skipped = await outbox.sendNow(row2._id);
    assert.equal(skipped.status, "cancelled");
    assert.match(skipped.lastError, /set a password/);
    assert.equal(sent.length, 1, "nothing sent to someone who no longer needs it");
  });

  await t.test("stays under the daily sending limit unless told otherwise", async function (t2) {
    mailMock.mockTransport(t2);
    var p = await seed();
    var previous = process.env.EMAIL_DAILY_LIMIT;
    process.env.EMAIL_DAILY_LIMIT = "2";
    t2.after(function restore() {
      if (previous === undefined) delete process.env.EMAIL_DAILY_LIMIT;
      else process.env.EMAIL_DAILY_LIMIT = previous;
    });
    var res = await request(app).post("/api/admin/setup-reminders").set(as(p.admin)).send({});
    assert.equal(res.body.queued, 2);
    assert.equal(res.body.deferredByLimit, 1);
    await setupReminders.idle();
    var rest = await request(app).post("/api/admin/setup-reminders").set(as(p.admin)).send({ allowOverLimit: true });
    assert.equal(rest.body.queued, 1);
    await setupReminders.idle();
  });

  await db.closeDatabase();
});
