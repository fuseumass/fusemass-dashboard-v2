"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var mongoose = require("mongoose");
var Assignment = require("../schemas/judgingAssignment");
var Score = require("../schemas/judgingScore");
var State = require("../schemas/judgingState");
var Project = require("../schemas/project");
var Profile = require("../schemas/judgeProfile");
var Room = require("../schemas/judgingRoom");
var Settings = require("../schemas/orgSettings");
var algorithm = require("../utils/judging/assignments");
var getCriteria = require("../utils/judging/criteria").getCriteria;
var criteria = []; // The live rubric, loaded once the database is up.
var JudgingSettings = require("../schemas/judgingSettings");
var adminRoot = "/api/admin/judging";
function auth(person) { return { Authorization: "Bearer " + person.token }; }
function post(person, path, body) { return request(app).post(path).set(auth(person)).send(body || {}); }
function queue(person) { return request(app).get("/api/judging/queue").set(auth(person)).expect(200); }
function rubric() {
  return Object.fromEntries(criteria.map(function score(c) { return [c.key, c.max]; }));
}
function score(person, project, values) {
  return post(person, "/api/judging/scores", { projectId: String(project), scores: values || rubric(), comments: "Notes" });
}
async function judge(hardware) {
  var person = await fixtures.createUser({ role: "judge" });
  await Profile.create({ user: person.user._id, hardware: !!hardware });
  return person;
}
async function project(room, n, extra) {
  return Project.create(Object.assign({ name: "Project " + n, devpostUrl: "https://devpost.com/software/p" + n,
    hardware: room.hardware, room: room._id, tableNumber: n, deskCheckedInAt: new Date(), tableCheckedInAt: new Date() }, extra));
}

test("judging assignments and scoring", async function (t) {
  await db.connect();
  t.after(db.closeDatabase);
  await db.clearDatabase();
  var admin = await fixtures.createUser({ role: "admin" });
  var regular = await judge(false);
  var hardware = await judge(true);
  var second = await judge(false);
  var room = await Room.create({ name: "Regular", order: 1, capacity: 10 });
  var hardRoom = await Room.create({ name: "Hardware", order: 2, capacity: 10, hardware: true });
  var a = await project(room, 1);
  var b = await project(room, 3); // vacant table 2 must not alter room mapping
  var c = await project(room, 4);
  var h = await project(hardRoom, 11);
  var ineligible = await project(room, 5, { tableCheckedInAt: null });
  var absent = await project(room, 6, { deskCheckedInAt: null });
  var withdrawn = await project(room, 7, { withdrawn: true });
  // Judging starts closed (JudgingSettings.judgingOpen); open it like an admin would.
  assert.equal((await queue(regular)).body.judgingOpenedAt, null);
  await post(admin, adminRoot + "/open").expect(200);
  var firstOpenedAt = (await JudgingSettings.getSingleton()).judgingOpenedAt.toISOString();
  assert.ok(Number.isFinite(Date.parse(firstOpenedAt)));
  assert.equal((await queue(regular)).body.judgingOpenedAt, firstOpenedAt);
  assert.equal((await JudgingSettings.getSingleton()).criteriaLocked, true);
  criteria = await getCriteria();

  await t.test("generation validates inputs, isolates pools, uses capacities and requires both check-ins", async function (t2) {
    await post(admin, adminRoot + "/assignments", { slotMinutes: 0 }).expect(400);
    await post(admin, adminRoot + "/assignments", { judgingsPerProject: 1.5 }).expect(400);
    var original = algorithm.generateJudgingAssignments;
    var configs = [];
    t2.mock.method(algorithm, "generateJudgingAssignments", function generate(config) {
      configs.push(config);
      return original(config);
    });
    var result = await post(admin, adminRoot + "/assignments", { judgingsPerProject: 1, slotMinutes: 5 }).expect(201);
    assert.equal(result.body.assignment.version, 1);
    assert.equal(result.body.assignment.params.slotMinutes, 5);
    assert.deepEqual(configs.map(function capacities(c) { return c.roomCapacities; }), [[10], [10]]);
    var queues = result.body.assignment.queues;
    var hardwareQueue = queues.find(function mine(q) { return q.judge === hardware.user.id; });
    assert.deepEqual(hardwareQueue.projects, [h.id]);
    assert.ok(queues.filter(function other(q) { return q.judge !== hardware.user.id; }).every(function regular(q) { return !q.projects.includes(h.id); }));
    var all = queues.flatMap(function projects(q) { return q.projects; });
    assert.ok(!all.includes(ineligible.id) && !all.includes(absent.id) && !all.includes(withdrawn.id));
    assert.equal((await queue(regular)).body.version, null);
  });
  await t.test("verifier failure or repair exception saves nothing", async function (t2) {
    var before = await Assignment.countDocuments();
    t2.mock.method(algorithm, "generateJudgingAssignments", function failed() { return { success: false, issues: ["collision"], log: [] }; });
    var bad = await post(admin, adminRoot + "/assignments", { judgingsPerProject: 1 }).expect(422);
    assert.equal(bad.body.verifierReport[0].success, false);
    assert.equal(await Assignment.countDocuments(), before);
    algorithm.generateJudgingAssignments = function failed() { throw new Error("repair failed"); };
    await post(admin, adminRoot + "/assignments", { judgingsPerProject: 1 }).expect(422);
    assert.equal(await Assignment.countDocuments(), before);
  });
  await t.test("too few hardware judges rejects the entire generation", async function () {
    await post(admin, adminRoot + "/assignments", { judgingsPerProject: 2 }).expect(422);
    assert.equal(await Assignment.countDocuments(), 1);
  });

  // An explicit schedule makes the advancing regression independent of RNG.
  await Assignment.create({ version: 2, createdBy: admin.user._id,
    params: { judgingsPerProject: 1, slotMinutes: 5 }, verifierReport: [{ success: true }],
    queues: [{ judge: regular.user._id, projects: [a._id, b._id, c._id], slots: [a._id, null, b._id, c._id], skipped: [] }] });
  await post(admin, adminRoot + "/assignments/2/activate").expect(200);
  await t.test("queue includes first project, slot gaps, safe project fields and position", async function () {
    var result = (await queue(regular)).body;
    assert.equal(result.current._id, a.id);
    assert.equal(result.current.position, 1);
    assert.equal(result.current.status, "current");
    assert.equal(result.assignments[0]._id, a.id);
    assert.equal(result.slotMinutes, 5);
    assert.equal(result.judgingOpenedAt, firstOpenedAt);
    assert.equal(result.assignments[1].slot, 3);
    assert.equal(result.total, 3);
    assert.equal(result.current.room.name, "Regular");
    assert.equal(result.current.submitterEmail, undefined);
    assert.equal(result.current.members, undefined);
    assert.equal(result.criteria.length, 6);
  });
  await t.test("server rejects range, fractional, string, extra and missing criteria", async function () {
    for (var values of [Object.assign(rubric(), { innovation: 11 }), Object.assign(rubric(), { qa: -1 }),
      Object.assign(rubric(), { practicality: 1.5 }), Object.assign(rubric(), { qa: "3" }), Object.assign(rubric(), { extra: 1 }), {}]) {
      await score(regular, a.id, values).expect(400);
    }
    var missing = rubric(); delete missing.qa;
    await score(regular, a.id, missing).expect(400);
    assert.equal(await Score.countDocuments(), 0);
    assert.equal((await queue(regular)).body.current._id, a.id);
  });
  await t.test("403 outside queue, 404 unknown, future scores and non-current skips rejected", async function () {
    await score(regular, h.id).expect(403);
    await score(hardware, a.id).expect(403);
    await score(regular, new mongoose.Types.ObjectId()).expect(404);
    await score(regular, "unknown").expect(404);
    await score(regular, c.id).expect(409);
    await post(regular, "/api/judging/skip", { projectId: b.id }).expect(409);
  });
  await t.test("skip, score skipped, rescore done never consume the current project", async function () {
    await post(regular, "/api/judging/skip", { projectId: a.id }).expect(200);
    var skipped = (await queue(regular)).body;
    assert.equal(skipped.current._id, b.id);
    assert.deepEqual(skipped.skipped.map(function id(p) { return p._id; }), [a.id]);
    assert.equal(skipped.assignments[0].status, "skipped");
    await score(regular, a.id).expect(200);
    var after = (await queue(regular)).body;
    assert.equal(after.current._id, b.id);
    assert.equal(after.skipped.length, 0);
    assert.deepEqual(after.done.map(function id(p) { return p._id; }), [a.id]);
    await score(regular, a.id, Object.assign(rubric(), { innovation: 2 })).expect(200);
    assert.equal((await queue(regular)).body.current._id, b.id);
    assert.equal(await Score.countDocuments({ judge: regular.user._id, project: a._id }), 1);
    assert.equal((await Score.findOne({ judge: regular.user._id, project: a._id })).scores.get("innovation"), 2);
    await score(regular, b.id).expect(200);
    assert.equal((await queue(regular)).body.current._id, c.id);
  });
  await t.test("freeze blocks writes and skips including rescoring; reopen allows them", async function () {
    await post(admin, adminRoot + "/close").expect(200);
    assert.equal((await queue(regular)).body.judgingOpen, false);
    await score(regular, a.id).expect(409);
    await score(regular, c.id).expect(409);
    await post(regular, "/api/judging/skip", { projectId: c.id }).expect(409);
    assert.equal((await queue(regular)).body.judgingOpenedAt, firstOpenedAt);
    await post(admin, adminRoot + "/open/").expect(200);
    assert.equal((await JudgingSettings.getSingleton()).judgingOpenedAt.toISOString(), firstOpenedAt);
    assert.equal((await queue(regular)).body.judgingOpenedAt, firstOpenedAt);
    await request(app).patch(adminRoot + "/settings").set(auth(admin)).send({ judgingOpen: false }).expect(200);
    await request(app).patch(adminRoot + "/settings").set(auth(admin)).send({ judgingOpen: true }).expect(200);
    assert.equal((await queue(regular)).body.judgingOpenedAt, firstOpenedAt);
    await score(regular, c.id).expect(200);
    assert.equal((await queue(regular)).body.current, null);
  });
  await t.test("activation retains scores and done status for projects in new queue", async function () {
    await Assignment.create({ version: 3, createdBy: admin.user._id, params: { judgingsPerProject: 1 },
      queues: [{ judge: regular.user._id, projects: [b._id, a._id], slots: [b._id, a._id] }] });
    await post(admin, adminRoot + "/assignments/3/activate").expect(200);
    assert.equal(await Score.countDocuments(), 3);
    var result = (await queue(regular)).body;
    assert.equal(result.done.length, 2);
    assert.equal(result.current, null);
    await post(admin, adminRoot + "/assignments/999/activate").expect(404);
    var versions = await request(app).get(adminRoot + "/assignments").set(auth(admin)).expect(200);
    assert.equal(versions.body.versions.length, 3);
    assert.equal(versions.body.activeVersion, 3);
  });
  await t.test("late judge additions validate hardware and check-ins, removal keeps scores", async function () {
    await post(admin, adminRoot + "/assignments/judges", { judgeId: second.user.id, projectIds: [h.id] }).expect(400);
    await post(admin, adminRoot + "/assignments/judges", { judgeId: second.user.id, projectIds: [ineligible.id] }).expect(400);
    await post(admin, adminRoot + "/assignments/judges", { judgeId: second.user.id, projectIds: [a.id, a.id] }).expect(400);
    await post(admin, adminRoot + "/assignments/judges", { judgeId: second.user.id, projectIds: [a.id] }).expect(200);
    assert.equal((await queue(second)).body.current._id, a.id);
    var changed = await Assignment.findOne({ version: 3 });
    assert.deepEqual(changed.queues[1].slots.slice(0, 2), [null, null]);
    await request(app).delete(adminRoot + "/assignments/judges/" + second.user.id).set(auth(admin)).expect(200);
    await score(second, a.id).expect(403);
    assert.equal(await Score.countDocuments(), 3);
  });
  await t.test("withdraw removes all active queue references and cannot be revived by activation", async function () {
    await post(admin, adminRoot + "/projects/" + a.id + "/withdraw").expect(200);
    var changed = await Assignment.findOne({ version: 3 });
    assert.ok(changed.queues.every(function removed(q) { return !q.projects.map(String).includes(a.id) && !q.slots.map(String).includes(a.id); }));
    await score(regular, a.id).expect(403);
    await post(admin, adminRoot + "/assignments/2/activate").expect(200);
    assert.ok(!(await queue(regular)).body.assignments.some(function removed(p) { return p._id === a.id; }));
    assert.equal(await Score.countDocuments(), 3);
    await post(admin, adminRoot + "/projects/" + new mongoose.Types.ObjectId() + "/withdraw").expect(404);
  });
  await t.test("project override withdrawal also prunes queues", async function () {
    await request(app).patch(adminRoot + "/projects/" + b.id).set(auth(admin)).send({ withdrawn: true }).expect(200);
    assert.ok(!(await queue(regular)).body.assignments.some(function removed(p) { return p._id === b.id; }));
  });
  await t.test("demoting a judge removes active queue; stale JWT loses access", async function () {
    await request(app).patch("/api/admin/users/" + regular.user.id + "/role").set(auth(admin)).send({ role: "applicant" }).expect(200);
    assert.ok(!(await Assignment.findOne({ version: 2 })).queues.some(function removed(q) { return String(q.judge) === regular.user.id; }));
    await request(app).get("/api/judging/queue").set(auth(regular)).expect(403);
    assert.equal(await Score.countDocuments(), 3);
  });
  await t.test("regeneration increments version without activating or deleting scores", async function () {
    var result = await post(admin, adminRoot + "/assignments", { judgingsPerProject: 1 }).expect(201);
    assert.equal(result.body.assignment.version, 4);
    assert.equal(result.body.assignment.params.slotMinutes, null);
    assert.equal((await State.findById("judging")).activeVersion, 2);
    assert.equal(await Score.countDocuments(), 3);
  });
  await t.test("new endpoints enforce auth and feature gate", async function () {
    var paths = [["get", "/api/judging/queue"], ["post", "/api/judging/scores"], ["post", "/api/judging/skip"],
      ["get", adminRoot + "/assignments"], ["post", adminRoot + "/assignments"], ["post", adminRoot + "/close"], ["post", adminRoot + "/open"],
      ["post", adminRoot + "/assignments/1/activate"], ["post", adminRoot + "/assignments/judges"],
      ["delete", adminRoot + "/assignments/judges/" + second.user.id], ["post", adminRoot + "/projects/" + c.id + "/withdraw"]];
    for (var entry of paths) await request(app)[entry[0]](entry[1]).expect(401);
    await Settings.updateOne({}, { $set: { "features.judging": false } }, { upsert: true });
    for (var route of paths) await request(app)[route[0]](route[1]).set(auth(admin)).expect(404);
    assert.equal((await State.findById("judging")).busyUntil, null);
  });
});
