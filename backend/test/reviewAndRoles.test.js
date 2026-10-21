"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var mongoose = require("mongoose");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var app = require("../server");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var User = require("../schemas/user");

var FORM = [
  { key: "year", label: "Graduation Year", type: "select", options: ["2027", "2028"] },
  { key: "why", label: "Why do you want to come?", type: "textarea" },
];

/**
 * A round with a form, one pending application, and a user of each role.
 * @returns {Promise<object>}
 */
async function seed() {
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
  var round = await ApplicationRound.create({ name: "General", isOpen: true, formConfig: FORM });
  var applicant = await fixtures.createUser({ role: "applicant", email: "ada@example.com" });
  var moderator = await fixtures.createUser({ role: "moderator" });
  var admin = await fixtures.createUser({ role: "admin" });
  var application = await Application.create({
    applicant: applicant.user._id,
    round: round._id,
    status: "pending",
    name: "Ada Lovelace",
    phone: "4135550100",
    university: "UMass Amherst",
    answers: { year: "2027", why: "To build things." },
  });
  return { round: round, applicant: applicant, moderator: moderator, admin: admin, application: application };
}

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

test("review endpoints and moderator access", async function (t) {
  await db.connect();

  // ---- Review list and one application ---------------------------------------

  await t.test("the list carries only the table's columns, not answers or the form", async function () {
    var s = await seed();
    var res = await request(app).get("/api/admin/applications").set(as(s.moderator));
    assert.equal(res.status, 200);
    var row = res.body.applications[0];
    assert.equal(row.name, "Ada Lovelace");
    assert.equal(row.university, "UMass Amherst");
    assert.equal(row.status, "pending");
    assert.equal(row.applicant.email, "ada@example.com");
    assert.equal(row.round.name, "General");
    assert.equal(row.hasResume, false);
    assert.equal(row.answers, undefined, "answers come from the detail endpoint");
    assert.equal(row.phone, undefined);
    assert.equal(row.round.formConfig, undefined, "the form isn't copied into every row");
  });

  await t.test("GET /api/admin/applications/:id returns one in full, with its round's form", async function () {
    var s = await seed();
    var res = await request(app).get("/api/admin/applications/" + s.application._id).set(as(s.moderator));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.application.answers, { year: "2027", why: "To build things." });
    assert.equal(res.body.application.phone, "4135550100");
    assert.equal(res.body.application.round.formConfig.length, 2);
    assert.equal(res.body.application.applicant.email, "ada@example.com");
    assert.equal(res.body.application.resumeBlobName, undefined);
  });

  await t.test("only reviewers can open an application; bad ids are 404", async function () {
    var s = await seed();
    var path = "/api/admin/applications/" + s.application._id;
    assert.equal((await request(app).get(path).set(as(s.admin))).status, 200);
    assert.equal((await request(app).get(path).set(as(s.applicant))).status, 403);
    assert.equal((await request(app).get(path)).status, 401);
    assert.equal((await request(app).get("/api/admin/applications/not-an-id").set(as(s.admin))).status, 404);
    assert.equal((await request(app).get("/api/admin/applications/" + new mongoose.Types.ObjectId()).set(as(s.admin))).status, 404);
  });

  // ---- Moderators ----------------------------------------------------------------

  await t.test("a moderator can accept, waitlist and reject", async function (t2) {
    var s = await seed();
    mailMock.mockTransport(t2);
    var path = "/api/admin/applications/" + s.application._id;
    for (var decision of ["waitlisted", "rejected", "accepted"]) {
      var res = await request(app).patch(path).set(as(s.moderator)).send({ decision: decision });
      assert.equal(res.status, 200, decision);
      assert.equal(res.body.application.status, decision);
    }
  });

  await t.test("a moderator can't manage users, roles, rounds or settings", async function () {
    var s = await seed();
    var checks = [
      request(app).get("/api/admin/users").set(as(s.moderator)),
      request(app).patch("/api/admin/users/" + s.applicant.user._id + "/role").set(as(s.moderator)).send({ role: "moderator" }),
      request(app).patch("/api/admin/users/" + s.moderator.user._id + "/role").set(as(s.moderator)).send({ role: "admin" }),
      request(app).get("/api/admin/rounds").set(as(s.moderator)),
      request(app).patch("/api/admin/settings").set(as(s.moderator)).send({ publicApplications: false }),
    ];
    var results = await Promise.all(checks);
    results.forEach(function (res) {
      assert.equal(res.status, 403);
    });
    assert.equal((await User.findById(s.moderator.user._id)).role, "moderator", "no self-promotion");
  });

  await t.test("someone promoted to moderator gets access on their existing login", async function () {
    var s = await seed();
    var before = await request(app).get("/api/admin/applications").set(as(s.applicant));
    assert.equal(before.status, 403);

    var promote = await request(app)
      .patch("/api/admin/users/" + s.applicant.user._id + "/role")
      .set(as(s.admin))
      .send({ role: "moderator" });
    assert.equal(promote.status, 200);

    // Same token as before: its role claim still says "applicant".
    var after = await request(app).get("/api/admin/applications").set(as(s.applicant));
    assert.equal(after.status, 200);
  });

  await t.test("demoting a moderator cuts off access on their very next request", async function () {
    var s = await seed();
    assert.equal((await request(app).get("/api/admin/applications").set(as(s.moderator))).status, 200);

    await request(app)
      .patch("/api/admin/users/" + s.moderator.user._id + "/role")
      .set(as(s.admin))
      .send({ role: "applicant" });

    var res = await request(app).get("/api/admin/applications").set(as(s.moderator));
    assert.equal(res.status, 403);
  });

  await t.test("a token for a deleted account is refused", async function () {
    var s = await seed();
    await User.deleteOne({ _id: s.moderator.user._id });
    assert.equal((await request(app).get("/api/admin/applications").set(as(s.moderator))).status, 401);
  });

  await db.closeDatabase();
});
