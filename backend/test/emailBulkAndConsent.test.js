"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var flaky = require("./helpers/flakyMail");
var app = require("../server");
var outbox = require("../utils/outbox");
var unsubscribe = require("../utils/unsubscribe");
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
 * Fresh DB + seeded templates + an announcement template + no remembered failures.
 * @returns {Promise<void>}
 */
function resetFixtures() {
  outbox.resetBreaker();
  return db.clearDatabase().then(function afterClear() {
    return EmailTemplate.seedDefaults();
  }).then(function addNews() {
    return EmailTemplate.create({ key: "news", subject: "News from {{orgName}}", body: "Hi {{name}}, big news ({{status}})!" });
  });
}

/**
 * Create an application for a user in a round.
 * @param {object} person - {user} from fixtures.createUser.
 * @param {object} round - ApplicationRound document.
 * @param {string} status - Application status.
 * @param {Date} [createdAt] - Override creation time (to order rounds).
 * @returns {Promise<object>}
 */
function apply(person, round, status, createdAt) {
  var fields = { applicant: person.user._id, round: round._id, name: person.user.name, status: status };
  if (createdAt) {
    fields.createdAt = createdAt;
  }
  return Application.create(fields);
}

/**
 * Send everything queued.
 * @returns {Promise<number>}
 */
function drain() {
  return outbox.processDue({ force: true });
}

test("B26: bulk email segments and marketing consent", async function bulkAndConsent(t) {
  await db.connect();

  await t.test("consent is off by default, asked at sign-up, and editable in the profile", async function () {
    await resetFixtures();

    var plain = await request(app)
      .post("/api/auth/register")
      .send({ name: "Pat", email: "pat@example.com", password: "password-123" });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.user.marketingEmailConsent, false);

    var yes = await request(app)
      .post("/api/auth/register")
      .send({ name: "Yes", email: "yes@example.com", password: "password-123", marketingEmailConsent: true });
    assert.equal(yes.body.user.marketingEmailConsent, true);

    // Only a real `true` counts; no truthy-string accidents.
    var sneaky = await request(app)
      .post("/api/auth/register")
      .send({ name: "Sn", email: "sn@example.com", password: "password-123", marketingEmailConsent: "yes" });
    assert.equal(sneaky.body.user.marketingEmailConsent, false);

    var token = { token: plain.body.token };
    var on = await request(app).patch("/api/auth/me").set(as(token)).send({ marketingEmailConsent: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.user.marketingEmailConsent, true);
    assert.equal((await request(app).get("/api/auth/me").set(as(token))).body.user.marketingEmailConsent, true);
    var off = await request(app).patch("/api/auth/me").set(as(token)).send({ marketingEmailConsent: false });
    assert.equal(off.body.user.marketingEmailConsent, false);

    assert.equal((await request(app).patch("/api/auth/me").set(as(token)).send({ marketingEmailConsent: "maybe" })).status, 400);
    assert.equal((await request(app).patch("/api/auth/me").send({ marketingEmailConsent: true })).status, 401);

    // The profile route can't be used to change anything else.
    await request(app).patch("/api/auth/me").set(as(token)).send({ marketingEmailConsent: true, role: "admin" });
    assert.equal((await User.findOne({ email: "pat@example.com" })).role, "applicant");
  });

  await t.test("the unsubscribe link switches announcements off, repeatably, and can't be forged", async function () {
    await resetFixtures();
    var fan = await fixtures.createUser({ marketingEmailConsent: true });
    var other = await fixtures.createUser({ marketingEmailConsent: true });
    var id = String(fan.user._id);

    var url = new URL(unsubscribe.link(fan.user._id));
    assert.equal(url.pathname, "/unsubscribe");
    var u = url.searchParams.get("u");
    var tok = url.searchParams.get("t");
    assert.equal(u, id);

    var forged = await request(app).post("/api/auth/unsubscribe").send({ u: id, t: unsubscribe.sign(other.user._id) });
    assert.equal(forged.status, 400);
    assert.equal((await request(app).post("/api/auth/unsubscribe").send({ u: "nope", t: tok })).status, 400);
    assert.equal((await request(app).post("/api/auth/unsubscribe").send({ u: id })).status, 400);
    assert.equal((await User.findById(fan.user._id)).marketingEmailConsent, true, "nothing changed yet");

    var ok = await request(app).post("/api/auth/unsubscribe").send({ u: u, t: tok });
    assert.equal(ok.status, 200);
    assert.equal((await User.findById(fan.user._id)).marketingEmailConsent, false);
    assert.equal((await request(app).post("/api/auth/unsubscribe").send({ u: u, t: tok })).status, 200, "idempotent");
    assert.equal((await User.findById(other.user._id)).marketingEmailConsent, true);
  });

  await t.test("segments: the ones that depend on unbuilt features are listed as unavailable", async function () {
    await resetFixtures();
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await request(app).get("/api/admin/outbox/segments").set(as(admin));
    assert.equal(res.status, 200);
    var byKey = {};
    res.body.segments.forEach(function (s) {
      byKey[s.key] = s;
    });
    ["not_applied", "pending", "accepted", "waitlisted", "rejected", "checked_in", "test_to_me"].forEach(function (key) {
      assert.equal(byKey[key].available, true, key);
    });
    assert.equal(byKey.workshop_signups.available, false);
    assert.match(byKey.workshop_signups.reason, /Workshops/);
    assert.equal(byKey.hardware_holders.available, false);
    assert.equal(res.body.dailyLimit, 500);
  });

  await t.test("announcements go only to people who opted in; transactional goes to the whole segment", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.create({ name: "R1", isOpen: true });
    var yes = await fixtures.createUser({ email: "yes@example.com", name: "Yes", marketingEmailConsent: true });
    var no = await fixtures.createUser({ email: "no@example.com", name: "No", marketingEmailConsent: false });
    var pending = await fixtures.createUser({ email: "pending@example.com", marketingEmailConsent: true });
    await apply(yes, round, "accepted");
    await apply(no, round, "accepted");
    await apply(pending, round, "pending");

    var dry = await request(app)
      .post("/api/admin/outbox/bulk")
      .set(as(admin))
      .send({ segment: "accepted", templateKey: "news", dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dryRun, true);
    assert.equal(dry.body.inSegment, 2);
    assert.equal(dry.body.recipients, 1);
    assert.equal(dry.body.skippedNoConsent, 1);
    assert.equal(dry.body.category, "announcement");
    assert.equal(await EmailLog.countDocuments({}), 0, "a dry run queues nothing");

    var sent = await request(app)
      .post("/api/admin/outbox/bulk")
      .set(as(admin))
      .send({ segment: "accepted", templateKey: "news" });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.queued, 1);
    assert.ok(sent.body.batchId);

    // Double-clicking "send" a second time is refused rather than doubled.
    var doubled = await request(app)
      .post("/api/admin/outbox/bulk")
      .set(as(admin))
      .send({ segment: "accepted", templateKey: "news" });
    assert.equal(doubled.status, 409);
    assert.equal(doubled.body.code, "DUPLICATE_SEND");

    await drain();
    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "yes@example.com");
    assert.match(mail.calls[0].text, /Hi Yes, big news \(accepted\)!/);
    assert.match(mail.calls[0].text, /Unsubscribe: http/);
    assert.match(mail.calls[0].headers["List-Unsubscribe"], /^<http.*\/unsubscribe\?u=/);
    var row = await EmailLog.findOne({ to: "yes@example.com" });
    assert.equal(row.category, "announcement");
    assert.equal(row.batchId, sent.body.batchId);
    assert.equal(String(row.requestedBy), String(admin.user._id));
    assert.equal(String(row.user), String(yes.user._id));

    // Transactional: everyone in the segment, whatever they opted into.
    var tx2 = await request(app)
      .post("/api/admin/outbox/bulk")
      .set(as(admin))
      .send({ segment: "accepted", templateKey: "application_accepted", category: "transactional" });
    assert.equal(tx2.status, 200);
    assert.equal(tx2.body.queued, 2);
    await drain();
    assert.deepEqual(
      mail.calls.slice(1).map(function (c) { return c.to; }).sort(),
      ["no@example.com", "yes@example.com"]
    );
    assert.ok(mail.calls[1].attachments, "the acceptance email keeps its QR code");
    assert.equal(mail.calls[1].headers, undefined, "no unsubscribe link on transactional mail");
    assert.ok(pending);
  });

  await t.test("segments pick the right people: latest application wins; not applied excludes staff", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin", marketingEmailConsent: true, email: "admin@example.com" });
    var r1 = await ApplicationRound.create({ name: "Early", isOpen: false });
    var r2 = await ApplicationRound.create({ name: "Regular", isOpen: true });
    var day = 24 * 60 * 60 * 1000;
    var bounced = await fixtures.createUser({ email: "bounced@example.com", marketingEmailConsent: true });
    await apply(bounced, r1, "rejected", new Date(Date.now() - 5 * day));
    await apply(bounced, r2, "pending", new Date(Date.now() - 1 * day)); // reapplied: now pending
    var waitlisted = await fixtures.createUser({ email: "wait@example.com", marketingEmailConsent: true });
    await apply(waitlisted, r2, "waitlisted");
    var rejected = await fixtures.createUser({ email: "rej@example.com", marketingEmailConsent: true });
    await apply(rejected, r2, "rejected");
    var drafter = await fixtures.createUser({ email: "draft@example.com", marketingEmailConsent: true });
    await apply(drafter, r2, "draft");
    await fixtures.createUser({ email: "never@example.com", marketingEmailConsent: true });
    await fixtures.createUser({ email: "mod@example.com", role: "moderator", marketingEmailConsent: true });
    await fixtures.createUser({ email: "arrived@example.com", marketingEmailConsent: true, checkedIn: true });

    /**
     * Dry-run a segment and return who would get it.
     * @param {string} segment - Segment key.
     * @returns {Promise<number>}
     */
    async function count(segment) {
      var res = await request(app)
        .post("/api/admin/outbox/bulk")
        .set(as(admin))
        .send({ segment: segment, templateKey: "news", dryRun: true });
      assert.equal(res.status, 200, segment + ": " + JSON.stringify(res.body));
      return res.body.recipients;
    }

    assert.equal(await count("pending"), 1, "bounced (latest application is pending)");
    assert.equal(await count("rejected"), 1, "only rej@, not bounced (their earlier rejection is superseded)");
    assert.equal(await count("waitlisted"), 1);
    assert.equal(await count("draft"), 1);
    assert.equal(await count("accepted"), 0);
    assert.equal(await count("checked_in"), 1);
    assert.equal(await count("not_applied"), 2, "never@ and arrived@; not the moderator or admin");
    assert.equal(await count("test_to_me"), 1);

    // Narrow to a round: bounced's first-round application was rejected.
    var inRound = await request(app)
      .post("/api/admin/outbox/bulk")
      .set(as(admin))
      .send({ segment: "rejected", templateKey: "news", dryRun: true, round: String(r1._id) });
    assert.equal(inRound.body.recipients, 1);
    assert.equal(mail.attempts, 0);
  });

  await t.test("test to me sends to the admin alone, with an unsubscribe link, even if they never opted in", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin", email: "boss@example.com", marketingEmailConsent: false });
    await fixtures.createUser({ email: "bystander@example.com", marketingEmailConsent: true });

    var res = await request(app)
      .post("/api/admin/outbox/bulk")
      .set(as(admin))
      .send({ segment: "test_to_me", templateKey: "news" });
    assert.equal(res.status, 200);
    assert.equal(res.body.queued, 1);
    assert.equal(res.body.category, "test");
    await drain();

    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "boss@example.com");
    assert.match(mail.calls[0].text, /Unsubscribe: http/);

    // And it can be repeated: no double-click guard on tests.
    assert.equal(
      (await request(app).post("/api/admin/outbox/bulk").set(as(admin)).send({ segment: "test_to_me", templateKey: "news" })).status,
      200
    );
    await drain();
    assert.equal(mail.calls.length, 2);
  });

  await t.test("bad requests: unknown or unavailable segment, unknown template, single-use-link template", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });

    var send = function (body) {
      return request(app).post("/api/admin/outbox/bulk").set(as(admin)).send(body);
    };
    assert.equal((await send({ segment: "everyone", templateKey: "news" })).status, 400);
    assert.equal((await send({ templateKey: "news" })).status, 400);
    var workshop = await send({ segment: "workshop_signups", templateKey: "news" });
    assert.equal(workshop.status, 400);
    assert.match(workshop.body.error, /Workshops/);
    assert.equal((await send({ segment: "hardware_holders", templateKey: "news" })).status, 400);
    assert.equal((await send({ segment: "accepted", templateKey: "nope" })).status, 404);
    assert.equal((await send({ segment: "accepted", templateKey: "account_setup" })).status, 400);
    assert.equal((await send({ segment: "accepted", templateKey: "news", round: "bad" })).status, 400);
    assert.equal(mail.attempts, 0);
    assert.equal(await EmailLog.countDocuments({}), 0);
  });

  await t.test("a bulk send past the daily limit is refused unless the admin insists", async function (t2) {
    await resetFixtures();
    flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.create({ name: "R", isOpen: true });
    for (var i = 0; i < 3; i += 1) {
      var person = await fixtures.createUser({ marketingEmailConsent: true });
      await apply(person, round, "pending");
    }
    process.env.EMAIL_DAILY_LIMIT = "2";
    try {
      var blocked = await request(app).post("/api/admin/outbox/bulk").set(as(admin)).send({ segment: "pending", templateKey: "news" });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, "OVER_DAILY_LIMIT");
      assert.equal(blocked.body.recipients, 3);
      assert.equal(await EmailLog.countDocuments({}), 0);

      var dry = await request(app).post("/api/admin/outbox/bulk").set(as(admin)).send({ segment: "pending", templateKey: "news", dryRun: true });
      assert.equal(dry.body.overLimit, true);

      var forced = await request(app)
        .post("/api/admin/outbox/bulk")
        .set(as(admin))
        .send({ segment: "pending", templateKey: "news", allowOverLimit: true });
      assert.equal(forced.status, 200);
      assert.equal(forced.body.queued, 3);
      await drain();
    } finally {
      delete process.env.EMAIL_DAILY_LIMIT;
    }
  });

  await t.test("someone who unsubscribes while a blast is draining stops getting it; the rest still send", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var stay = await fixtures.createUser({ email: "stay@example.com", marketingEmailConsent: true });
    var leave = await fixtures.createUser({ email: "leave@example.com", marketingEmailConsent: true });
    // Queued the way a bulk send leaves them, but not due yet, so the test
    // decides when the worker gets to them.
    var later = new Date(Date.now() + 60 * 60 * 1000);
    await EmailLog.create([
      { to: "stay@example.com", user: stay.user._id, templateKey: "news", category: "announcement", values: { name: "S" }, status: "queued", nextAttemptAt: later },
      { to: "leave@example.com", user: leave.user._id, templateKey: "news", category: "announcement", values: { name: "L" }, status: "queued", nextAttemptAt: later },
    ]);

    var link = new URL(unsubscribe.link(leave.user._id));
    var res = await request(app)
      .post("/api/auth/unsubscribe")
      .send({ u: link.searchParams.get("u"), t: link.searchParams.get("t") });
    assert.equal(res.status, 200);
    await EmailLog.updateMany({}, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await drain();

    assert.deepEqual(mail.calls.map(function (c) { return c.to; }), ["stay@example.com"]);
    assert.equal((await EmailLog.findOne({ to: "leave@example.com" })).status, "cancelled");
  });

  await t.test("a whole bulk send can be cancelled while it is still queued", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    // Rows as a bulk send leaves them, held back (not due yet) so the test
    // controls when anything sends.
    var later = new Date(Date.now() + 60 * 60 * 1000);
    var rows = [];
    for (var i = 0; i < 5; i += 1) {
      rows.push({
        to: "r" + i + "@example.com",
        templateKey: "news",
        category: "announcement",
        status: "queued",
        batchId: i < 3 ? "batch-a" : "batch-b",
        nextAttemptAt: later,
      });
    }
    await EmailLog.create(rows);
    // One that is being sent right now can't be cancelled out from under the send.
    var inFlight = await EmailLog.create({
      to: "now@example.com",
      templateKey: "news",
      status: "queued",
      batchId: "batch-a",
      attempts: 1,
      lockedUntil: new Date(Date.now() + 60 * 1000),
    });

    var one = await request(app).post("/api/admin/outbox/cancel-queued").set(as(admin)).send({ batchId: "batch-a" });
    assert.equal(one.status, 200);
    assert.equal(one.body.cancelled, 3);
    assert.equal(await EmailLog.countDocuments({ batchId: "batch-b", status: "queued" }), 2, "other batches are untouched");
    assert.equal((await EmailLog.findById(inFlight._id)).status, "queued");

    var rest = await request(app).post("/api/admin/outbox/cancel-queued").set(as(admin)).send({});
    assert.equal(rest.body.cancelled, 2);
    assert.equal(await drain(), 0);
    assert.equal(mail.attempts, 0, "nothing that was cancelled ever sends");
  });

  await t.test("resend acceptance emails: everyone accepted who has no sent one logged, QR included", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var r1 = await ApplicationRound.create({ name: "R1", isOpen: false });
    var r2 = await ApplicationRound.create({ name: "R2", isOpen: true });
    var day = 24 * 60 * 60 * 1000;

    var old = await fixtures.createUser({ email: "old@example.com", name: "Old Timer" }); // accepted before QR codes shipped
    await apply(old, r1, "accepted");
    var recent = await fixtures.createUser({ email: "recent@example.com" }); // got a logged email already
    await apply(recent, r1, "accepted");
    await EmailLog.create({
      to: "recent@example.com",
      templateKey: "application_accepted",
      status: "sent",
      attempts: 1,
      sentAt: new Date(),
    });
    var bounced = await fixtures.createUser({ email: "reversed@example.com" }); // accepted, then rejected in a later round
    await apply(bounced, r1, "accepted", new Date(Date.now() - 3 * day));
    await apply(bounced, r2, "rejected", new Date(Date.now() - 1 * day));
    var pending = await fixtures.createUser({ email: "pending@example.com" });
    await apply(pending, r2, "pending");

    var dry = await request(app).post("/api/admin/outbox/resend-acceptance").set(as(admin)).send({ dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.inSegment, 2, "old and recent");
    assert.equal(dry.body.recipients, 1);
    assert.equal(dry.body.skippedAlreadySent, 1);
    assert.deepEqual(dry.body.warnings, []);
    assert.equal(mail.attempts, 0);

    var res = await request(app).post("/api/admin/outbox/resend-acceptance").set(as(admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.queued, 1);
    await drain();

    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "old@example.com");
    assert.match(mail.calls[0].subject, /accepted/i);
    assert.equal(mail.calls[0].attachments[0].cid, "checkin-qrcode");
    assert.match(mail.calls[0].text, /Old Timer/);
    var oldUser = await User.findOne({ email: "old@example.com" });
    assert.ok(oldUser.qrId, "their check-in code is issued if it was missing");

    // Doing it again finds nobody: this is how an admin runs it safely twice.
    var again = await request(app).post("/api/admin/outbox/resend-acceptance").set(as(admin)).send({ dryRun: true });
    assert.equal(again.body.recipients, 0);

    // ...unless they ask for everyone.
    var everyone = await request(app)
      .post("/api/admin/outbox/resend-acceptance")
      .set(as(admin))
      .send({ dryRun: true, includeAlreadySent: true });
    assert.equal(everyone.body.recipients, 2);
  });

  await t.test("resend acceptance warns when the template has lost its QR code, and a failed one can be retried", async function (t2) {
    await resetFixtures();
    var mail = flaky.mockFlakyTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.create({ name: "R", isOpen: true });
    var person = await fixtures.createUser({ email: "p@example.com" });
    await apply(person, round, "accepted");
    await EmailTemplate.updateOne({ key: "application_accepted" }, { $set: { body: "You're in, {{name}}." } });

    var dry = await request(app).post("/api/admin/outbox/resend-acceptance").set(as(admin)).send({ dryRun: true });
    assert.match(dry.body.warnings[0], /qrcode/);

    await EmailTemplate.updateOne({ key: "application_accepted" }, { $set: { body: "You're in, {{name}}.\n\n{{qrcode}}" } });
    mail.failNext(1, new Error("connect ETIMEDOUT"));
    var res = await request(app).post("/api/admin/outbox/resend-acceptance").set(as(admin));
    assert.equal(res.body.queued, 1);
    await drain(); // first attempt fails and is queued with a backoff
    var row = await EmailLog.findOne({ to: "p@example.com" });
    assert.equal(row.status, "queued");
    assert.equal(mail.calls.length, 0);

    await EmailLog.updateOne({ _id: row._id }, { $set: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await drain();
    assert.equal(mail.calls.length, 1);
    assert.equal((await EmailLog.findById(row._id)).status, "sent");
  });

  await db.closeDatabase();
});
