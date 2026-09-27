"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var ApplicationRound = require("../schemas/applicationRound");
var Application = require("../schemas/application");

test("T0: rounds, org settings, user management", async function orgAndRounds(t) {
  await db.connect();

  // ---- Rounds: create/open/close, only-open-round accepts submissions -----

  await t.test("admin can create, open, and close a round", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });

    var createRes = await request(app)
      .post("/api/admin/rounds")
      .set("Authorization", "Bearer " + admin.token)
      .send({ name: "Early Round" });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.round.isOpen, false);
    var roundId = createRes.body.round._id;

    var openRes = await request(app)
      .patch("/api/admin/rounds/" + roundId)
      .set("Authorization", "Bearer " + admin.token)
      .send({ isOpen: true });
    assert.equal(openRes.status, 200);
    assert.equal(openRes.body.round.isOpen, true);

    var closeRes = await request(app)
      .patch("/api/admin/rounds/" + roundId)
      .set("Authorization", "Bearer " + admin.token)
      .send({ isOpen: false });
    assert.equal(closeRes.status, 200);
    assert.equal(closeRes.body.round.isOpen, false);
  });

  await t.test("submitting with no open round is rejected", async function () {
    await db.clearDatabase();
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Test")
      .field("status", "draft");
    assert.equal(res.status, 400);
  });

  await t.test("closing the open round blocks further submissions", async function () {
    await db.clearDatabase();
    var round = await ApplicationRound.create({ name: "R", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var firstSubmit = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Test")
      .field("status", "draft");
    assert.equal(firstSubmit.status, 200);

    round.isOpen = false;
    await round.save();

    var secondSubmit = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Test")
      .field("status", "draft");
    assert.equal(secondSubmit.status, 400);
  });

  await t.test(
    "opensAt/closesAt are stored but not enforced — only isOpen gates submission " +
      "(documents current behavior; a round with future opensAt is still submittable while isOpen)",
    async function () {
      await db.clearDatabase();
      await ApplicationRound.create({
        name: "Future Round",
        isOpen: true,
        opensAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // opens tomorrow
        closesAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // "closed" yesterday
      });
      var applicant = await fixtures.createUser({ role: "applicant" });

      var res = await request(app)
        .post("/api/applications")
        .set("Authorization", "Bearer " + applicant.token)
        .field("name", "Test")
        .field("status", "draft");
      assert.equal(res.status, 200);
    }
  );

  await t.test("one application per applicant per round: re-submitting updates the same document", async function () {
    await db.clearDatabase();
    await ApplicationRound.create({ name: "R", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var first = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "First Name")
      .field("status", "draft");
    assert.equal(first.status, 200);

    var second = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Updated Name")
      .field("status", "draft");
    assert.equal(second.status, 200);

    assert.equal(second.body.application._id, first.body.application._id);
    var count = await Application.countDocuments({ applicant: applicant.user._id });
    assert.equal(count, 1);
  });

  await t.test("draft vs pending: draft doesn't count as submitted, pending does", async function () {
    await db.clearDatabase();
    await ApplicationRound.create({ name: "R", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var draftRes = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Test")
      .field("status", "draft");
    assert.equal(draftRes.body.application.status, "draft");

    var submitRes = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Test")
      .field("status", "pending");
    assert.equal(submitRes.body.application.status, "pending");
  });

  // ---- Org settings / Google toggle ---------------------------------------

  await t.test("Google sign-in is hidden via /api/meta/config when env credentials are absent", async function () {
    // GOOGLE_CLIENT_ID/SECRET are unset in the test env, so this is the "hard
    // gate" case — true end-to-end toggle testing needs real Google
    // credentials, which this environment doesn't have (see backend-tasks.md
    // T0: "needs real Google credentials" is explicitly out of scope here).
    var res = await request(app).get("/api/meta/config");
    assert.equal(res.status, 200);
    assert.equal(res.body.googleAuthEnabled, false);
  });

  await t.test("/api/auth/google is unavailable when env credentials are absent, regardless of the admin toggle", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });

    // Try to turn the org setting ON — should still have no effect without
    // env credentials (envAllowsGoogle() is the hard gate).
    await request(app)
      .patch("/api/admin/settings")
      .set("Authorization", "Bearer " + admin.token)
      .send({ googleAuthEnabled: true });

    var res = await request(app).get("/api/auth/google");
    assert.equal(res.status, 501);
  });

  await t.test("admin can read and update org settings", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });

    var getRes = await request(app)
      .get("/api/admin/settings")
      .set("Authorization", "Bearer " + admin.token);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.googleEnvAllowed, false);

    var patchRes = await request(app)
      .patch("/api/admin/settings")
      .set("Authorization", "Bearer " + admin.token)
      .send({ googleAuthEnabled: false });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.body.settings.googleAuthEnabled, false);
  });

  // ---- User search + promote -----------------------------------------------

  await t.test("admin can search users and promote one to moderator, then admin", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var target = await fixtures.createUser({ name: "Findable Person", role: "applicant" });

    var searchRes = await request(app)
      .get("/api/admin/users?q=Findable")
      .set("Authorization", "Bearer " + admin.token);
    assert.equal(searchRes.status, 200);
    assert.ok(
      searchRes.body.users.some(function (u) {
        return String(u._id) === String(target.user._id);
      })
    );

    var promoteRes = await request(app)
      .patch("/api/admin/users/" + target.user._id + "/role")
      .set("Authorization", "Bearer " + admin.token)
      .send({ role: "moderator" });
    assert.equal(promoteRes.status, 200);
    assert.equal(promoteRes.body.user.role, "moderator");

    var promoteAgain = await request(app)
      .patch("/api/admin/users/" + target.user._id + "/role")
      .set("Authorization", "Bearer " + admin.token)
      .send({ role: "admin" });
    assert.equal(promoteAgain.status, 200);
    assert.equal(promoteAgain.body.user.role, "admin");
  });

  await db.closeDatabase();
});
