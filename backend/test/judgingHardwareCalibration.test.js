"use strict";

require("./helpers/testEnv");
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Profile = require("../schemas/judgeProfile");

var adminRoot = "/api/admin/judging";
function auth(person) { return { Authorization: "Bearer " + person.token }; }
function project(title) { return { title: title, description: "", link: "" }; }
// Every criterion at its minimum or maximum: the general mean is then the
// same for everyone using the same end, so peers can be compared exactly.
function scores(criteria, end) {
  return Object.fromEntries(criteria.map(function pair(c) { return [c.key, end === "max" ? c.max : c.min]; }));
}

test("hardware and general judges calibrate on separate practice projects", async function (t) {
  await db.connect();
  t.after(db.closeDatabase);
  await db.clearDatabase();
  var admin = await fixtures.createUser({ role: "admin" });
  async function judge(name, hardware, role) {
    var person = await fixtures.createUser({ role: role || "judge", name: name });
    await Profile.create({ user: person.user._id, hardware: Boolean(hardware) });
    return person;
  }
  var g1 = await judge("General One");
  var g2 = await judge("General Two");
  var h1 = await judge("Hardware One", true);
  var h2 = await judge("Hardware Two", true);
  var adminJudge = await judge("Admin Judge", false, "admin");

  await request(app).patch(adminRoot + "/settings").set(auth(admin)).send({ hardwareCalibrationProjects: [] }).expect(400);
  var saved = await request(app).patch(adminRoot + "/settings").set(auth(admin)).send({
    calibrationProjects: [project("Web app"), project("Mobile app")],
    hardwareCalibrationProjects: [project("Robot arm")],
  }).expect(200);
  var criteria = saved.body.settings.criteria;

  await t.test("each judge gets their own list", async function () {
    var hw = (await request(app).get("/api/judging/calibration").set(auth(h1)).expect(200)).body;
    assert.equal(hw.track, "hardware");
    assert.deepEqual(hw.rounds.map(function title(r) { return r.title; }), ["Robot arm"]);
    var gen = (await request(app).get("/api/judging/calibration").set(auth(g1)).expect(200)).body;
    assert.equal(gen.track, "general");
    assert.deepEqual(gen.rounds.map(function title(r) { return r.title; }), ["Web app", "Mobile app"]);
    var adm = (await request(app).get("/api/judging/calibration").set(auth(adminJudge)).expect(200)).body;
    assert.equal(adm.track, "general");
  });

  await t.test("round numbers follow the judge's own list", async function () {
    await request(app).post("/api/judging/calibration/2").set(auth(h1)).send({ scores: scores(criteria, "max") }).expect(400);
    var done = (await request(app).post("/api/judging/calibration/1").set(auth(h1)).send({ scores: scores(criteria, "max") }).expect(200)).body;
    assert.equal(done.calibrationDone, true, "one hardware round completes hardware calibration");
    await request(app).post("/api/judging/calibration/1").set(auth(h2)).send({ scores: scores(criteria, "min") }).expect(200);
    for (var person of [g1, g2]) {
      var first = (await request(app).post("/api/judging/calibration/1").set(auth(person)).send({ scores: scores(criteria, "min") }).expect(200)).body;
      assert.equal(first.calibrationDone, false);
      await request(app).post("/api/judging/calibration/2").set(auth(person)).send({ scores: scores(criteria, "min") }).expect(200);
    }
  });

  await t.test("bias is computed within each group", async function () {
    var rows = (await request(app).post(adminRoot + "/bias").set(auth(admin)).expect(200)).body.judges;
    var by = Object.fromEntries(rows.map(function row(r) { return [r.name, r]; }));
    assert.ok(by["Admin Judge"], "admins on the judges tab are listed");
    assert.equal(by["Admin Judge"].done, false);
    assert.equal(by["Hardware One"].hardware, true);
    // General judges scored identically, so neither is biased, even though the
    // hardware judges scored at the extremes on a different project.
    assert.equal(by["General One"].bias.general, 0);
    assert.equal(by["General Two"].bias.category, 0);
    assert.ok(by["Hardware One"].bias.general > 0);
    assert.equal(by["Hardware One"].bias.general, -by["Hardware Two"].bias.general);
    assert.equal(by["Hardware One"].bias.category, -by["Hardware Two"].bias.category);
  });

  await t.test("changing one list resets only that group", async function () {
    await request(app).patch(adminRoot + "/settings").set(auth(admin)).send({
      hardwareCalibrationProjects: [project("Robot arm"), project("Smart lamp")],
    }).expect(200);
    var hw = await Profile.findOne({ user: h1.user._id });
    assert.equal(hw.calibrationScores.length, 0);
    assert.equal(hw.bias, null);
    var gen = await Profile.findOne({ user: g1.user._id });
    assert.equal(gen.calibrationScores.length, 2);
    // Retitling without changing the number of rounds keeps everyone's work.
    await request(app).patch(adminRoot + "/settings").set(auth(admin)).send({
      calibrationProjects: [project("Web app v2"), project("Mobile app")],
    }).expect(200);
    assert.equal((await Profile.findOne({ user: g1.user._id })).calibrationScores.length, 2);
  });

  await t.test("switching a judge between hardware and general resets their calibration", async function () {
    await request(app).patch("/api/admin/judges/" + g2.user.id).set(auth(admin)).send({ hardware: true }).expect(200);
    var switched = await Profile.findOne({ user: g2.user._id });
    assert.equal(switched.hardware, true);
    assert.equal(switched.calibrationScores.length, 0);
    assert.equal(switched.calibrationDone, false);
    var now = (await request(app).get("/api/judging/calibration").set(auth(g2)).expect(200)).body;
    assert.equal(now.track, "hardware");
    // Re-inviting with the same flag keeps calibration.
    await request(app).post("/api/judging/calibration/1").set(auth(g1)).send({ scores: scores(criteria, "min") }).expect(200);
    await request(app).post("/api/admin/judges").set(auth(admin)).send({ name: "General One", email: g1.user.email, hardware: false }).expect(201);
    assert.equal((await Profile.findOne({ user: g1.user._id })).calibrationScores.length, 2);
    await request(app).post("/api/admin/judges").set(auth(admin)).send({ name: "General One", email: g1.user.email, hardware: true }).expect(201);
    assert.equal((await Profile.findOne({ user: g1.user._id })).calibrationScores.length, 0);
  });
});
