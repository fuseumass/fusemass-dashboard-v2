"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var EmailTemplate = require("../schemas/emailTemplate");
var ApplicationRound = require("../schemas/applicationRound");
var Application = require("../schemas/application");
var OrgSettings = require("../schemas/orgSettings");
var autoAccept = require("../utils/autoAccept");

var HOUR_MS = 60 * 60 * 1000;

/**
 * Fresh DB, templates and one open round.
 * @returns {Promise<object>} The round.
 */
async function reset() {
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
  return ApplicationRound.create({ name: "General", isOpen: true });
}

/**
 * A pending application from `email`, submitted `minutesAgo` minutes ago.
 * @param {object} round - ApplicationRound.
 * @param {string} email - Applicant email.
 * @param {number} minutesAgo - Age, so "oldest first" is testable.
 * @param {object} [extra] - More Application fields.
 * @returns {Promise<object>} The Application.
 */
async function pendingFrom(round, email, minutesAgo, extra) {
  var person = await fixtures.createUser({ role: "applicant", email: email });
  return Application.create(
    Object.assign(
      {
        applicant: person.user._id,
        round: round._id,
        name: email.split("@")[0],
        status: "pending",
        createdAt: new Date(Date.now() - minutesAgo * 60000),
      },
      extra || {}
    )
  );
}

/**
 * Save the auto-accept setting directly.
 * @param {object} value - OrgSettings.autoAccept.
 * @returns {Promise<void>}
 */
async function setAutoAccept(value) {
  await OrgSettings.getSingleton();
  await OrgSettings.updateOne({ key: "default" }, { $set: { autoAccept: value } });
}

test("Domain auto-accept", async function autoAcceptSuite(t) {
  await db.connect();

  await t.test("domains are normalized and validated", async function () {
    assert.equal(autoAccept.normalizeDomain(" @UMass.edu "), "umass.edu");
    assert.equal(autoAccept.normalizeDomain("someone@umass.edu"), "umass.edu");
    assert.equal(autoAccept.normalizeDomain("not a domain"), null);
    var check = autoAccept.validateSettingsPatch({ domains: "umass.edu, @smith.edu umass.edu", emailsPerDay: 240 });
    assert.deepEqual(check.errors, []);
    assert.deepEqual(check.update["autoAccept.domains"], ["umass.edu", "smith.edu"]);
    assert.ok(autoAccept.validateSettingsPatch({ emailsPerDay: 0 }).errors.length);
    assert.ok(autoAccept.validateSettingsPatch({ enabled: "yes" }).errors.length);
    assert.ok(autoAccept.validateSettingsPatch({ sneaky: true }).errors.length);
  });

  await t.test("the pattern matches the domain and its subdomains, nothing else", async function () {
    var withSubs = autoAccept.emailPattern(["umass.edu"], true);
    assert.ok(withSubs.test("a@umass.edu"));
    assert.ok(withSubs.test("a@cs.umass.edu"));
    assert.ok(!withSubs.test("a@notumass.edu"));
    assert.ok(!withSubs.test("a@umass.edu.evil.com"));
    var exact = autoAccept.emailPattern(["umass.edu"], false);
    assert.ok(!exact.test("a@cs.umass.edu"));
  });

  await t.test("admins switch it on through PATCH /api/admin/settings", async function () {
    await reset();
    var admin = await fixtures.createUser({ role: "admin" });
    var res = await request(app)
      .patch("/api/admin/settings")
      .set("Authorization", "Bearer " + admin.token)
      .send({ autoAccept: { enabled: true, domains: ["@UMass.edu"], emailsPerDay: 240 } });
    assert.equal(res.status, 200);
    var settings = await OrgSettings.getSingleton();
    assert.equal(settings.autoAccept.enabled, true);
    assert.deepEqual(settings.autoAccept.domains.slice(), ["umass.edu"]);
    assert.equal(settings.autoAccept.emailsPerDay, 240);

    var bad = await request(app)
      .patch("/api/admin/settings")
      .set("Authorization", "Bearer " + admin.token)
      .send({ autoAccept: { domains: ["not a domain"] } });
    assert.equal(bad.status, 400);
  });

  await t.test("preview counts pending matches oldest first and skips flagged, other statuses and domains", async function () {
    var round = await reset();
    var admin = await fixtures.createUser({ role: "admin" });
    await pendingFrom(round, "old@umass.edu", 30);
    await pendingFrom(round, "new@cs.umass.edu", 5);
    await pendingFrom(round, "flagged@umass.edu", 20, { flagged: true });
    await pendingFrom(round, "done@umass.edu", 40, { status: "rejected" });
    await pendingFrom(round, "other@smith.edu", 50);

    var res = await request(app)
      .post("/api/admin/auto-accept/preview")
      .set("Authorization", "Bearer " + admin.token)
      .send({ domains: "umass.edu", emailsPerDay: 48 });
    assert.equal(res.status, 200);
    assert.equal(res.body.pending, 2);
    assert.equal(res.body.flaggedSkipped, 1);
    assert.deepEqual(
      res.body.sample.map(function (row) {
        return row.email;
      }),
      ["old@umass.edu", "new@cs.umass.edu"]
    );
    assert.equal(res.body.perHour, 2);
  });

  await t.test("does nothing while switched off", async function (t2) {
    var round = await reset();
    var mail = mailMock.mockTransport(t2);
    var app1 = await pendingFrom(round, "a@umass.edu", 10);
    await setAutoAccept({ enabled: false, domains: ["umass.edu"], emailsPerDay: 200 });
    var result = await autoAccept.runOnce();
    assert.equal(result.state, "off");
    assert.equal((await Application.findById(app1._id)).status, "pending");
    assert.equal(mail.calls.length, 0);
  });

  await t.test("accepts the oldest match, marks it auto-accepted and sends the acceptance email", async function (t2) {
    var round = await reset();
    var mail = mailMock.mockTransport(t2);
    var oldest = await pendingFrom(round, "oldest@umass.edu", 60);
    var newer = await pendingFrom(round, "newer@umass.edu", 5);
    // 24 a day = 1 an hour, so one run accepts exactly one.
    await setAutoAccept({ enabled: true, domains: ["umass.edu"], emailsPerDay: 24, includeSubdomains: true });

    var result = await autoAccept.runOnce();
    assert.equal(result.accepted, 1);
    var accepted = await Application.findById(oldest._id);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.autoAccepted, true);
    assert.equal((await Application.findById(newer._id)).status, "pending");
    await waitFor(function () {
      return mail.calls.some(function (call) {
        return call.to === "oldest@umass.edu";
      });
    });

    // The hour's budget is used: the next run waits.
    var again = await autoAccept.runOnce();
    assert.equal(again.state, "waiting");
    assert.equal((await Application.findById(newer._id)).status, "pending");
  });

  await t.test("never passes the daily number in any 24 hours", async function (t2) {
    var round = await reset();
    mailMock.mockTransport(t2);
    await setAutoAccept({ enabled: true, domains: ["umass.edu"], emailsPerDay: 2 });
    // Two auto-accepted 3 hours ago: the 24-hour number is used up.
    await pendingFrom(round, "x@umass.edu", 300, {
      status: "accepted",
      autoAccepted: true,
      reviewedAt: new Date(Date.now() - 3 * HOUR_MS),
    });
    await pendingFrom(round, "y@umass.edu", 300, {
      status: "accepted",
      autoAccepted: true,
      reviewedAt: new Date(Date.now() - 3 * HOUR_MS),
    });
    var waiting = await pendingFrom(round, "z@umass.edu", 10);
    var result = await autoAccept.runOnce();
    assert.equal(result.state, "waiting");
    assert.match(result.note, /last 24 hours/);
    assert.equal((await Application.findById(waiting._id)).status, "pending");

    // A day later the window has moved on.
    var later = await autoAccept.runOnce(new Date(Date.now() + 22 * HOUR_MS));
    assert.equal(later.accepted, 1);
  });

  await t.test("waits when the server's 24-hour email limit is used up", async function (t2) {
    var round = await reset();
    mailMock.mockTransport(t2);
    var previous = process.env.EMAIL_DAILY_LIMIT;
    process.env.EMAIL_DAILY_LIMIT = "1";
    t2.after(function restore() {
      if (previous === undefined) {
        delete process.env.EMAIL_DAILY_LIMIT;
      } else {
        process.env.EMAIL_DAILY_LIMIT = previous;
      }
    });
    var pending = await pendingFrom(round, "a@umass.edu", 10);
    await setAutoAccept({ enabled: true, domains: ["umass.edu"], emailsPerDay: 200 });
    var result = await autoAccept.runOnce();
    assert.equal(result.state, "waiting");
    assert.match(result.note, /email limit/);
    assert.equal((await Application.findById(pending._id)).status, "pending");
  });

  await t.test("the status route reports the setting and the queue", async function () {
    var round = await reset();
    var admin = await fixtures.createUser({ role: "admin" });
    await pendingFrom(round, "a@umass.edu", 10);
    await setAutoAccept({ enabled: true, domains: ["umass.edu"], emailsPerDay: 240 });
    var res = await request(app).get("/api/admin/auto-accept").set("Authorization", "Bearer " + admin.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.pending, 1);
    assert.equal(res.body.perHour, 10);
    assert.equal(res.body.hoursToFinish, 1);
  });

  await db.closeDatabase();
});
