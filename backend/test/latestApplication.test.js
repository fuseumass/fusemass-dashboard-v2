"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var User = require("../schemas/user");
var applicationStatus = require("../utils/applicationStatus");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

/**
 * @param {object} applicant - From fixtures.createUser.
 * @param {object} round - An ApplicationRound.
 * @param {string} status - Review status.
 * @param {Date} [createdAt] - When it was created.
 * @returns {Promise<object>}
 */
function apply(applicant, round, status, createdAt) {
  var fields = { applicant: applicant.user._id, round: round._id, status: status, name: "Ada Lovelace" };
  if (createdAt) {
    fields.createdAt = createdAt;
  }
  return Application.create(fields);
}

test("B27: pickLatest chooses the application that tells the applicant where they stand", function () {
  var old = new Date("2026-01-01");
  var recent = new Date("2026-03-01");

  assert.equal(applicationStatus.pickLatest([]), null);
  assert.equal(applicationStatus.pickLatest(undefined), null);
  assert.equal(applicationStatus.pickLatest([{ status: "draft", createdAt: recent }]), null, "a draft isn't a status");

  var rejectedNew = { status: "rejected", createdAt: recent };
  var pendingOld = { status: "pending", createdAt: old };
  assert.equal(applicationStatus.pickLatest([pendingOld, rejectedNew]), rejectedNew, "newest wins");
  assert.equal(applicationStatus.pickLatest([rejectedNew, pendingOld]), rejectedNew, "regardless of order");

  var acceptedOld = { status: "accepted", createdAt: old };
  assert.equal(applicationStatus.pickLatest([acceptedOld, rejectedNew]), acceptedOld, "accepted beats newer");
  assert.equal(applicationStatus.pickLatest([rejectedNew, acceptedOld]), acceptedOld);

  var acceptedNew = { status: "accepted", createdAt: recent };
  assert.equal(applicationStatus.pickLatest([acceptedOld, acceptedNew]), acceptedNew, "newest accepted");
  assert.equal(applicationStatus.pickLatest([{ status: "draft", createdAt: recent }, pendingOld]), pendingOld);
});

test("B27: GET /api/applications/me keeps accepted applicants' status once applications close", async function (t) {
  await db.connect();

  await t.test("no round is open: an accepted applicant still gets their application, round and check-in state", async function () {
    await db.clearDatabase();
    var round = await ApplicationRound.create({ name: "General Admission", isOpen: false });
    var attendee = await fixtures.createUser({ role: "applicant" });
    var accepted = await apply(attendee, round, "accepted");

    var res = await request(app).get("/api/applications/me").set(as(attendee));
    assert.equal(res.status, 200);
    assert.equal(res.body.round, null, "no round is open");
    assert.equal(res.body.application, null, "and so nothing for the open round");
    assert.equal(res.body.latest.application._id, String(accepted._id));
    assert.equal(res.body.latest.application.status, "accepted");
    assert.equal(res.body.latest.round.name, "General Admission");
    assert.equal(res.body.latest.round._id, String(round._id));
    assert.equal(res.body.latest.checkedIn, false);
    assert.equal(res.body.latest.checkedInAt, null);
  });

  await t.test("after check-in the same call reports it", async function () {
    await db.clearDatabase();
    var round = await ApplicationRound.create({ name: "General", isOpen: false });
    var attendee = await fixtures.createUser({ role: "applicant" });
    await apply(attendee, round, "accepted");
    var arrived = new Date("2026-11-07T09:30:00Z");
    await User.updateOne({ _id: attendee.user._id }, { $set: { checkedIn: true, checkedInAt: arrived } });

    var res = await request(app).get("/api/applications/me").set(as(attendee));
    assert.equal(res.body.latest.checkedIn, true);
    assert.equal(new Date(res.body.latest.checkedInAt).getTime(), arrived.getTime());
  });

  await t.test("while a round is open its fields are unchanged and latest rides along", async function () {
    await db.clearDatabase();
    var closed = await ApplicationRound.create({ name: "Early Bird", isOpen: false, order: 0 });
    var open = await ApplicationRound.create({ name: "General", isOpen: true, order: 1 });
    var attendee = await fixtures.createUser({ role: "applicant" });
    await apply(attendee, closed, "accepted");

    var res = await request(app).get("/api/applications/me").set(as(attendee));
    assert.equal(res.body.round.name, "General");
    assert.equal(res.body.round._id, String(open._id));
    assert.equal(res.body.application, null, "hasn't applied to the open round");
    assert.equal(res.body.latest.application.status, "accepted", "but is already in from Early Bird");
    assert.equal(res.body.latest.round.name, "Early Bird");

    var inOpen = await apply(attendee, open, "pending");
    var again = await request(app).get("/api/applications/me").set(as(attendee));
    assert.equal(again.body.application._id, String(inOpen._id));
    assert.equal(again.body.application.status, "pending");
    assert.equal(again.body.latest.application.status, "accepted", "accepted outranks the newer pending one");
  });

  await t.test("a rejected applicant sees the rejection from the most recent round", async function () {
    await db.clearDatabase();
    var first = await ApplicationRound.create({ name: "Round One", isOpen: false });
    var second = await ApplicationRound.create({ name: "Round Two", isOpen: false });
    var person = await fixtures.createUser({ role: "applicant" });
    await apply(person, first, "waitlisted", new Date("2026-01-01"));
    await apply(person, second, "rejected", new Date("2026-02-01"));

    var res = await request(app).get("/api/applications/me").set(as(person));
    assert.equal(res.body.latest.application.status, "rejected");
    assert.equal(res.body.latest.round.name, "Round Two");
  });

  await t.test("a draft is not a status; someone who never applied gets null", async function () {
    await db.clearDatabase();
    var round = await ApplicationRound.create({ name: "General", isOpen: false });
    var drafter = await fixtures.createUser({ role: "applicant" });
    var never = await fixtures.createUser({ role: "applicant" });
    await apply(drafter, round, "draft");

    assert.equal((await request(app).get("/api/applications/me").set(as(drafter))).body.latest, null);
    var res = await request(app).get("/api/applications/me").set(as(never));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { round: null, application: null, latest: null });
  });

  await t.test("it only ever describes the caller's own applications", async function () {
    await db.clearDatabase();
    var round = await ApplicationRound.create({ name: "General", isOpen: false });
    var mine = await fixtures.createUser({ role: "applicant" });
    var theirs = await fixtures.createUser({ role: "applicant" });
    await apply(theirs, round, "accepted");
    await User.updateOne({ _id: theirs.user._id }, { $set: { checkedIn: true } });

    var res = await request(app).get("/api/applications/me").set(as(mine));
    assert.equal(res.body.latest, null);
  });

  await t.test("it is slim: no answers, phone or other profile fields", async function () {
    await db.clearDatabase();
    var round = await ApplicationRound.create({ name: "General", isOpen: false });
    var person = await fixtures.createUser({ role: "applicant" });
    await Application.create({
      applicant: person.user._id,
      round: round._id,
      status: "accepted",
      name: "Ada",
      phone: "4135550100",
      answers: { why: "secret" },
    });

    var latest = (await request(app).get("/api/applications/me").set(as(person))).body.latest;
    assert.deepEqual(Object.keys(latest.application).sort(), ["_id", "createdAt", "name", "status", "updatedAt"]);
  });

  await t.test("it needs a login", async function () {
    var res = await request(app).get("/api/applications/me");
    assert.equal(res.status, 401);
  });

  await db.closeDatabase();
});
