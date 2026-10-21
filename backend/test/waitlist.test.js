"use strict";

// Public-apply calls below exceed the default auth rate limit (20 per window).
process.env.AUTH_RATE_LIMIT_MAX = "500";

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
var waitlist = require("../utils/waitlist");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

/**
 * Fresh database, built-in email templates and an open round.
 * @param {object} [roundFields] - Extra fields for the round.
 * @returns {Promise<object>} The open ApplicationRound.
 */
async function reset(roundFields) {
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
  return ApplicationRound.create(Object.assign({ name: "General", isOpen: true }, roundFields || {}));
}

/**
 * Put `count` accepted applications in a round.
 * @param {object} round - The ApplicationRound.
 * @param {number} count - How many.
 * @param {string} [status="accepted"] - Status to give them.
 * @returns {Promise<void>}
 */
async function fillRound(round, count, status) {
  for (var i = 0; i < count; i++) {
    var person = await fixtures.createUser({ role: "applicant" });
    await Application.create({
      applicant: person.user._id,
      round: round._id,
      status: status || "accepted",
      name: "Attendee " + i,
    });
  }
}

/**
 * Submit (or save as a draft) the logged-in applicant's application.
 * @param {object} applicant - From fixtures.createUser.
 * @param {string} [status="pending"] - "pending" submits, "draft" saves.
 * @param {string} [name="Ada Lovelace"] - Applicant name.
 * @returns {Promise<object>} The supertest response.
 */
function submit(applicant, status, name) {
  return request(app)
    .post("/api/applications")
    .set(as(applicant))
    .field("name", name || "Ada Lovelace")
    .field("status", status || "pending");
}

/**
 * Give outgoing mail a moment to (not) happen.
 * @returns {Promise<void>}
 */
function settle() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 150);
  });
}

test("B41: waitlist limit rules", function () {
  assert.equal(waitlist.hasLimit(null), false);
  assert.equal(waitlist.hasLimit(undefined), false);
  assert.equal(waitlist.hasLimit(0), false, "0 is not a limit");
  assert.equal(waitlist.hasLimit(1), true);
  assert.equal(waitlist.hasLimit(2.5), false);
  assert.equal(waitlist.hasLimit("5"), false);

  assert.equal(waitlist.shouldWaitlist(null, 1000), false, "no limit, never");
  assert.equal(waitlist.shouldWaitlist(3, 2), false);
  assert.equal(waitlist.shouldWaitlist(3, 3), true, "full at exactly the limit");
  assert.equal(waitlist.shouldWaitlist(3, 4), true, "and over it");

  assert.deepEqual(waitlist.parseLimit(undefined), { value: null });
  assert.deepEqual(waitlist.parseLimit(null), { value: null });
  assert.deepEqual(waitlist.parseLimit(""), { value: null });
  assert.deepEqual(waitlist.parseLimit("  "), { value: null });
  assert.deepEqual(waitlist.parseLimit(250), { value: 250 });
  assert.deepEqual(waitlist.parseLimit("250"), { value: 250 });
  ["0", 0, -3, 2.5, "abc", "12px", true, [], {}].forEach(function (bad) {
    assert.match(waitlist.parseLimit(bad).error, /whole number of at least 1/, JSON.stringify(bad));
  });
});

test("B41: setting a round's waitlist limit", async function (t) {
  await db.connect();

  await t.test("admins set, change and clear it; it defaults to no limit", async function () {
    var round = await reset();
    var admin = await fixtures.createUser({ role: "admin" });
    assert.equal(round.waitlistAfterAccepted, null);

    var created = await request(app).post("/api/admin/rounds").set(as(admin)).send({ name: "Capped", waitlistAfterAccepted: "300" });
    assert.equal(created.status, 201);
    assert.equal(created.body.round.waitlistAfterAccepted, 300);

    var path = "/api/admin/rounds/" + round._id;
    var set = await request(app).patch(path).set(as(admin)).send({ waitlistAfterAccepted: 250 });
    assert.equal(set.status, 200);
    assert.equal(set.body.round.waitlistAfterAccepted, 250);

    var listed = await request(app).get("/api/admin/rounds").set(as(admin));
    var row = listed.body.rounds.find(function (r) {
      return r._id === String(round._id);
    });
    assert.equal(row.waitlistAfterAccepted, 250, "staff see it");

    var other = await request(app).patch(path).set(as(admin)).send({ name: "Renamed" });
    assert.equal(other.body.round.waitlistAfterAccepted, 250, "unrelated edits leave it alone");

    var cleared = await request(app).patch(path).set(as(admin)).send({ waitlistAfterAccepted: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.round.waitlistAfterAccepted, null);

    var blank = await request(app).patch(path).set(as(admin)).send({ waitlistAfterAccepted: 10 });
    assert.equal(blank.body.round.waitlistAfterAccepted, 10);
    var blanked = await request(app).patch(path).set(as(admin)).send({ waitlistAfterAccepted: "" });
    assert.equal(blanked.body.round.waitlistAfterAccepted, null, "an empty box clears it");
  });

  await t.test("bad values are refused and change nothing", async function () {
    var round = await reset({ waitlistAfterAccepted: 100 });
    var admin = await fixtures.createUser({ role: "admin" });
    var path = "/api/admin/rounds/" + round._id;

    for (var bad of [0, -1, 2.5, "lots"]) {
      var res = await request(app).patch(path).set(as(admin)).send({ waitlistAfterAccepted: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.match(res.body.error, /whole number of at least 1/);
    }
    var create = await request(app).post("/api/admin/rounds").set(as(admin)).send({ name: "Bad", waitlistAfterAccepted: 0 });
    assert.equal(create.status, 400);
    assert.equal((await ApplicationRound.findById(round._id)).waitlistAfterAccepted, 100);
  });

  await t.test("moderators and applicants can't set it", async function () {
    var round = await reset();
    var moderator = await fixtures.createUser({ role: "moderator" });
    var applicant = await fixtures.createUser({ role: "applicant" });
    var path = "/api/admin/rounds/" + round._id;
    assert.equal((await request(app).patch(path).set(as(moderator)).send({ waitlistAfterAccepted: 5 })).status, 403);
    assert.equal((await request(app).patch(path).set(as(applicant)).send({ waitlistAfterAccepted: 5 })).status, 403);
    assert.equal((await ApplicationRound.findById(round._id)).waitlistAfterAccepted, null);
  });

  await t.test("applicants never see the limit (it is the round's capacity)", async function () {
    await reset({ waitlistAfterAccepted: 100 });
    await OrgSettings.create({ key: "default", publicApplications: true });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var mine = await request(app).get("/api/applications/me").set(as(applicant));
    assert.equal(mine.body.round.name, "General");
    assert.equal("waitlistAfterAccepted" in mine.body.round, false);

    var pub = await request(app).get("/api/applications/public/round");
    assert.equal(pub.status, 200);
    assert.equal("waitlistAfterAccepted" in pub.body.round, false);
  });

  await db.closeDatabase();
});

test("B41: waitlist mode on submit", async function (t) {
  await db.connect();

  await t.test("under the limit a submission is pending and gets the usual received email", async function (t2) {
    var round = await reset({ waitlistAfterAccepted: 3 });
    var mail = mailMock.mockTransport(t2);
    await fillRound(round, 2);
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await submit(applicant);
    assert.equal(res.status, 200);
    assert.equal(res.body.application.status, "pending");

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    await settle();
    assert.equal(mail.calls.length, 1);
    assert.match(mail.calls[0].subject, /Thanks for applying/);
  });

  await t.test("at the limit a submission is waitlisted and told so, instead of the received email", async function (t2) {
    var round = await reset({ waitlistAfterAccepted: 3 });
    var mail = mailMock.mockTransport(t2);
    await fillRound(round, 3);
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await submit(applicant);
    assert.equal(res.status, 200);
    assert.equal(res.body.application.status, "waitlisted");
    assert.equal((await Application.findOne({ applicant: applicant.user._id })).status, "waitlisted");

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    await settle();
    assert.equal(mail.calls.length, 1, "one email, not two");
    assert.equal(mail.calls[0].to, applicant.user.email);
    assert.match(mail.calls[0].subject, /waitlist/i);
    assert.match(mail.calls[0].text, /Status: waitlisted/);
    assert.doesNotMatch(mail.calls[0].text, /pending review/);
  });

  await t.test("the limit is reached as people are accepted: the next submission flips", async function (t2) {
    await reset({ waitlistAfterAccepted: 2 });
    mailMock.mockTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var late = await fixtures.createUser({ role: "applicant" });

    // Pending applications don't use up spots (three are pending against a
    // limit of two); only accepted ones do.
    var ids = [];
    for (var i = 0; i < 3; i++) {
      var res = await submit(await fixtures.createUser({ role: "applicant" }));
      assert.equal(res.body.application.status, "pending");
      ids.push(res.body.application._id);
    }

    await request(app).patch("/api/admin/applications/" + ids[0]).set(as(admin)).send({ decision: "accepted" });
    var under = await submit(late);
    assert.equal(under.body.application.status, "pending", "one of two spots taken");
    await Application.deleteOne({ _id: under.body.application._id });

    await request(app).patch("/api/admin/applications/" + ids[1]).set(as(admin)).send({ decision: "accepted" });
    assert.equal((await submit(late)).body.application.status, "waitlisted", "both taken");
  });

  await t.test("only accepted applications in this round count", async function (t2) {
    var round = await reset({ waitlistAfterAccepted: 2 });
    mailMock.mockTransport(t2);
    var elsewhere = await ApplicationRound.create({ name: "Earlier", isOpen: false });
    await fillRound(elsewhere, 5);
    await fillRound(round, 1, "waitlisted");
    await fillRound(round, 1, "rejected");
    await fillRound(round, 1, "pending");
    await fillRound(round, 1, "accepted");
    var applicant = await fixtures.createUser({ role: "applicant" });

    assert.equal((await submit(applicant)).body.application.status, "pending", "1 accepted of 2");
  });

  await t.test("a round without a limit never waitlists", async function (t2) {
    var round = await reset();
    mailMock.mockTransport(t2);
    await fillRound(round, 20);
    var applicant = await fixtures.createUser({ role: "applicant" });
    assert.equal((await submit(applicant)).body.application.status, "pending");
  });

  await t.test("a draft isn't waitlisted until it is submitted", async function (t2) {
    var round = await reset({ waitlistAfterAccepted: 1 });
    var mail = mailMock.mockTransport(t2);
    await fillRound(round, 1);
    var applicant = await fixtures.createUser({ role: "applicant" });

    var draft = await submit(applicant, "draft");
    assert.equal(draft.body.application.status, "draft");
    await settle();
    assert.equal(mail.calls.length, 0, "saving a draft emails nobody");

    var sent = await submit(applicant, "pending");
    assert.equal(sent.body.application.status, "waitlisted");
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.match(mail.calls[0].subject, /waitlist/i);
  });

  await t.test("editing a waitlisted application keeps it waitlisted and sends nothing more", async function (t2) {
    var round = await reset({ waitlistAfterAccepted: 1 });
    var mail = mailMock.mockTransport(t2);
    await fillRound(round, 1);
    var applicant = await fixtures.createUser({ role: "applicant" });
    await submit(applicant);
    await waitFor(function () {
      return mail.calls.length >= 1;
    });

    var edited = await submit(applicant, "pending", "Ada King");
    assert.equal(edited.status, 200);
    assert.equal(edited.body.application.status, "waitlisted");
    assert.equal(edited.body.application.name, "Ada King", "the edit itself was saved");
    await settle();
    assert.equal(mail.calls.length, 1);
  });

  await t.test("a spot opening up doesn't promote anyone; the waitlist is the reviewers' to work through", async function (t2) {
    var round = await reset({ waitlistAfterAccepted: 1 });
    mailMock.mockTransport(t2);
    await fillRound(round, 1);
    var applicant = await fixtures.createUser({ role: "applicant" });
    await submit(applicant);

    await Application.updateOne({ round: round._id, status: "accepted" }, { $set: { status: "rejected" } });
    await submit(applicant, "pending", "Ada King");
    assert.equal((await Application.findOne({ applicant: applicant.user._id })).status, "waitlisted");
  });

  await t.test("editing keeps whatever status review gave an application (an edit can't undo a decision)", async function (t2) {
    await reset({ waitlistAfterAccepted: 100 });
    var mail = mailMock.mockTransport(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var accepted = await fixtures.createUser({ role: "applicant" });
    var rejected = await fixtures.createUser({ role: "applicant" });

    var first = await submit(accepted);
    var second = await submit(rejected);
    await request(app).patch("/api/admin/applications/" + first.body.application._id).set(as(admin)).send({ decision: "accepted" });
    await request(app).patch("/api/admin/applications/" + second.body.application._id).set(as(admin)).send({ decision: "rejected" });
    await waitFor(function () {
      return mail.calls.length >= 4;
    });
    var before = mail.calls.length;

    assert.equal((await submit(accepted, "pending", "Ada King")).body.application.status, "accepted");
    assert.equal((await submit(rejected, "pending", "Bob King")).body.application.status, "rejected");
    await settle();
    assert.equal(mail.calls.length, before, "and no emails");
  });

  await t.test("reviewers can still accept past the limit", async function (t2) {
    var round = await reset({ waitlistAfterAccepted: 1 });
    mailMock.mockTransport(t2);
    await fillRound(round, 1);
    var admin = await fixtures.createUser({ role: "admin" });
    var applicant = await fixtures.createUser({ role: "applicant" });
    var res = await submit(applicant);
    assert.equal(res.body.application.status, "waitlisted");

    var decided = await request(app)
      .patch("/api/admin/applications/" + res.body.application._id)
      .set(as(admin))
      .send({ decision: "accepted" });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.application.status, "accepted");
    assert.equal(await Application.countDocuments({ round: round._id, status: "accepted" }), 2);
  });

  await db.closeDatabase();
});

test("B41: waitlist mode when applying without an account", async function (t) {
  await db.connect();

  /**
   * @param {object} fields - Form fields.
   * @returns {Promise<object>} The supertest response.
   */
  function applyPublic(fields) {
    var req = request(app).post("/api/applications/public");
    Object.keys(fields).forEach(function (key) {
      req = req.field(key, String(fields[key]));
    });
    return req;
  }

  await t.test("a full round waitlists and emails the waitlist template", async function (t2) {
    var round = await reset({ waitlistAfterAccepted: 1 });
    await OrgSettings.create({ key: "default", publicApplications: true });
    var mail = mailMock.mockTransport(t2);
    await fillRound(round, 1);

    var res = await applyPublic({ email: "ada@example.com", name: "Ada Lovelace" });
    assert.equal(res.status, 201);
    assert.equal(res.body.application.status, "waitlisted");

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    await settle();
    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "ada@example.com");
    assert.match(mail.calls[0].subject, /waitlist/i);
  });

  await t.test("a round with room is pending, with the received email", async function (t2) {
    await reset({ waitlistAfterAccepted: 5 });
    await OrgSettings.create({ key: "default", publicApplications: true });
    var mail = mailMock.mockTransport(t2);

    var res = await applyPublic({ email: "ada@example.com", name: "Ada Lovelace" });
    assert.equal(res.body.application.status, "pending");
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.match(mail.calls[0].subject, /Thanks for applying/);
  });

  await db.closeDatabase();
});
