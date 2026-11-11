"use strict";

// Editing a judge from the admin Judges page: PATCH /api/admin/judges/:id.

require("./helpers/testEnv");
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var User = require("../schemas/user");
var JudgeProfile = require("../schemas/judgeProfile");
var JudgingState = require("../schemas/judgingState");

function auth(token) {
  return "Bearer " + token;
}

test("admins can edit judges", async function suite(t) {
  await db.connect();
  t.after(async function close() {
    await db.closeDatabase();
  });
  await db.clearDatabase();

  var admin = await fixtures.createUser({ role: "admin" });
  var moderator = await fixtures.createUser({ role: "moderator" });
  var applicant = await fixtures.createUser({ email: "taken@example.com" });
  var judge = await fixtures.createUser({
    role: "judge",
    name: "Jdge One",
    email: "judge@exmaple.com",
    judgeInvitePending: true,
    resetPasswordToken: "hash-of-old-link",
    resetPasswordExpires: new Date(Date.now() + 86400000),
  });
  await JudgeProfile.create({ user: judge.user._id, hardware: false });
  var url = "/api/admin/judges/" + judge.user._id;

  await t.test("changes the name and email, normalized", async function nameEmail() {
    var res = await request(app)
      .patch(url)
      .set("Authorization", auth(admin.token))
      .send({ name: " Judge One ", email: " Judge@Example.com " });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.judge.name, "Judge One");
    assert.equal(res.body.judge.email, "judge@example.com");
    assert.equal(res.body.emailChanged, true);
    assert.equal(res.body.inviteNeedsResend, true);
    // The link mailed to the wrong address no longer works.
    assert.equal(res.body.judge.inviteStatus, "expired");
    var stored = await User.findById(judge.user._id).lean();
    assert.equal(stored.resetPasswordToken, undefined);
    assert.equal(stored.judgeInvitePending, true);
    assert.equal(stored.resetPasswordToken, undefined);
    assert.equal(res.body.judge.resetPasswordToken, undefined);
  });

  await t.test("validates the body", async function validation() {
    var bodies = [{ name: "" }, { email: "judge@example,com" }, { hardware: "yes" }, { role: "admin" }, { calibrationDone: true }];
    for (var body of bodies) {
      var res = await request(app).patch(url).set("Authorization", auth(admin.token)).send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    var stored = await User.findById(judge.user._id).lean();
    assert.equal(stored.role, "judge");
    var bad = await request(app).patch("/api/admin/judges/nope").set("Authorization", auth(admin.token)).send({ name: "x" });
    assert.equal(bad.status, 400);
    var missing = await request(app)
      .patch("/api/admin/judges/" + applicant.user._id)
      .set("Authorization", auth(admin.token))
      .send({ name: "x" });
    assert.equal(missing.status, 404, "only judges can be edited here");
  });

  await t.test("a duplicate email is a 409", async function duplicate() {
    var res = await request(app)
      .patch(url)
      .set("Authorization", auth(admin.token))
      .send({ email: "TAKEN@example.com", name: "Not Saved" });
    assert.equal(res.status, 409);
    var stored = await User.findById(judge.user._id).lean();
    assert.equal(stored.email, "judge@example.com");
    assert.equal(stored.name, "Judge One");
  });

  await t.test("toggles hardware, with a warning while assignments are active", async function hardware() {
    var res = await request(app).patch(url).set("Authorization", auth(admin.token)).send({ hardware: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.judge.hardware, true);
    assert.equal(res.body.warning, null);
    assert.equal((await JudgeProfile.findOne({ user: judge.user._id }).lean()).hardware, true);

    await JudgingState.create({ _id: "judging", activeVersion: 2 });
    res = await request(app).patch(url).set("Authorization", auth(admin.token)).send({ hardware: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.judge.hardware, false);
    assert.equal(res.body.warning, "Regenerate assignments for this to affect queues.");

    // No change, no warning.
    res = await request(app).patch(url).set("Authorization", auth(admin.token)).send({ hardware: false });
    assert.equal(res.body.warning, null);

    var list = await request(app).get("/api/admin/judges").set("Authorization", auth(admin.token));
    assert.equal(list.body.judges[0].hardware, false);
  });

  await t.test("only admins may edit judges", async function guards() {
    var body = { hardware: true };
    assert.equal((await request(app).patch(url).send(body)).status, 401);
    assert.equal((await request(app).patch(url).set("Authorization", auth(moderator.token)).send(body)).status, 403);
    assert.equal((await request(app).patch(url).set("Authorization", auth(applicant.token)).send(body)).status, 403);
    assert.equal((await request(app).patch(url).set("Authorization", auth(judge.token)).send(body)).status, 403);
    assert.equal((await JudgeProfile.findOne({ user: judge.user._id }).lean()).hardware, false);
  });
});
