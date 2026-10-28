"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Project = require("../schemas/project");
var Room = require("../schemas/judgingRoom");
var Table = require("../schemas/judgingTable");
var Application = require("../schemas/application");
var mailer = require("../utils/mailer");
var allocator = require("../utils/judging/tables");
function auth(person) { return { Authorization: "Bearer " + person.token }; }
function post(person, path, body) { return request(app).post(path).set(auth(person)).send(body || {}); }
var desk = "/api/staff/judging/desk-checkin";
var adminRoot = "/api/admin/judging";
async function member(hardware) {
  var person = await fixtures.createUser();
  await Application.create({ applicant: person.user._id, status: "accepted" });
  person.project = await Project.create({ name: "Project", devpostUrl: "https://devpost.com/software/" + person.user.id, members: [person.user._id], hardware: !!hardware });
  return person;
}

test("table layout uses global continuous numbering and room pools", function () {
  var slots = allocator.layout([{ _id: "a", capacity: 2, hardware: false }, { _id: "b", capacity: 2, hardware: true }]);
  assert.deepEqual(slots.map(function number(s) { return s.number; }), [1, 2, 3, 4]);
  assert.equal(slots[2].room, "b");
  assert.equal(slots[2].hardware, true);
});

test("unsupported transactions fall back to conditional unique-index allocation", async function (t) {
  var mongoose = require("mongoose");
  var ended = 0;
  var sessions = 0;
  var project = { _id: "project", tableNumber: 1, room: "room", deskCheckedInAt: new Date(), withdrawn: false };
  t.mock.method(mongoose, "startSession", async function start() {
    sessions++;
    return {
      withTransaction: async function unsupported() { throw Object.assign(new Error("Transaction numbers are only allowed on a replica set member"), { code: 20 }); },
      endSession: async function end() { ended++; },
    };
  });
  t.mock.method(Project, "findById", function find() {
    return { session: async function session(value) { assert.equal(value, null); return project; } };
  });
  t.mock.method(Project, "findOneAndUpdate", async function update(filter, changes, options) {
    assert.equal(filter.tableNumber, 1);
    assert.equal(options.session, null);
    return project;
  });
  var result = await allocator.assign("project", false);
  assert.equal(result.project.tableNumber, 1);
  assert.equal(result.changed, false);
  assert.equal(sessions, 1);
  assert.equal(ended, 1);
});

test("judging check-in integration", async function (t) {
  await db.connect();
  t.after(db.closeDatabase);
  await db.clearDatabase();
  var admin = await fixtures.createUser({ role: "admin" });
  var moderator = await fixtures.createUser({ role: "moderator" });
  var judge = await fixtures.createUser({ role: "judge" });
  var mails = [];
  t.mock.method(mailer, "sendTemplateEmail", function queued(to, key, data) {
    mails.push({ to: to, key: key, data: data });
    return Promise.resolve();
  });
  var a = await Room.create({ name: "First", order: 1, capacity: 10 });
  var b = await Room.create({ name: "Second", order: 2, capacity: 10 });
  await Room.create({ name: "Hardware", order: 3, capacity: 1, hardware: true });
  var people = [];
  for (var i = 0; i < 20; i++) people.push(await member());

  await t.test("20 parallel desk scans have distinct tables across rooms", async function () {
    var results = await Promise.all(people.map(function scan(p) {
      return post(moderator, desk, { userId: p.user.id }).expect(200);
    }));
    var numbers = results.map(function number(r) { return r.body.project.tableNumber; }).sort(function ascending(x, y) { return x - y; });
    assert.deepEqual(numbers, Array.from({ length: 20 }, function number(_, n) { return n + 1; }));
    var assigned = await Project.find({ hardware: false });
    assigned.forEach(function room(p) { assert.equal(String(p.room), String(p.tableNumber <= 10 ? a._id : b._id)); });
  });
  await t.test("emails are queued once per team member", async function () {
    // Background lookups finish independently of the desk response.
    for (var n = 0; n < 50 && mails.length < 20; n++) await new Promise(function pause(resolve) { setTimeout(resolve, 10); });
    assert.equal(mails.length, 20);
    assert.equal(mails[0].key, "judging_table_assigned");
    var repeat = await post(moderator, desk, { userId: people[0].user.id }).expect(200);
    assert.equal(repeat.body.alreadyAssigned, true);
    assert.equal(mails.length, 20);
  });
  var hardware = await member(true);
  await t.test("hardware pool and room full", async function () {
    var result = await post(moderator, desk, { userId: hardware.user.id }).expect(200);
    assert.equal(result.body.project.tableNumber, 21);
    assert.equal(result.body.project.room.name, "Hardware");
    var extra = await member();
    var full = await post(moderator, desk, { userId: extra.user.id }).expect(409);
    assert.match(full.body.error, /full/);
    var extraHardware = await member(true);
    await post(moderator, desk, { userId: extraHardware.user.id }).expect(409);
    await Project.deleteMany({ _id: { $in: [extra.project._id, extraHardware.project._id] } });
  });
  await t.test("several projects require a selection owned by the attendee", async function () {
    var second = await Project.create({ name: "Second project", devpostUrl: "https://devpost.com/software/second", members: [people[0].user._id] });
    var conflict = await post(moderator, desk, { userId: people[0].user.id }).expect(409);
    assert.equal(conflict.body.projects.length, 2);
    await post(moderator, desk, { userId: people[0].user.id, projectId: people[1].project.id }).expect(400);
    await post(moderator, desk, { userId: people[0].user.id, projectId: people[0].project.id }).expect(200);
    await second.deleteOne();
  });
  await t.test("sign tokens persist, wrong table is exact, desk required, table scans idempotent", async function () {
    await request(app).get(adminRoot + "/table-signs").set(auth(admin)).expect(200);
    var tokens = await Table.find({}).select("+token").sort({ number: 1 });
    await request(app).get(adminRoot + "/table-signs").set(auth(admin)).expect(200);
    assert.equal((await Table.findOne({ number: 1 }).select("+token")).token, tokens[0].token);
    var p = await Project.findById(people[0].project._id).populate("room");
    var wrong = tokens.find(function other(t) { return t.number !== p.tableNumber; });
    var bad = await post(people[0], "/api/judging/table-checkin", { token: wrong.token }).expect(409);
    assert.equal(bad.body.error, "Wrong table: you're at table " + wrong.number + ", go to table " + p.tableNumber + " in " + p.room.name);
    var correct = tokens.find(function own(t) { return t.number === p.tableNumber; });
    var first = await post(people[0], "/api/judging/table-checkin", { token: correct.token }).expect(200);
    var repeat = await post(people[0], "/api/judging/table-checkin", { token: correct.token }).expect(200);
    assert.equal(first.body.project.tableCheckedInAt, repeat.body.project.tableCheckedInAt);
    var fresh = await member();
    var before = await post(fresh, "/api/judging/table-checkin", { token: correct.token }).expect(409);
    assert.match(before.body.error, /desk first/);
    await fresh.project.deleteOne();
  });
  await t.test("undo records actor and time, frees number, bulk confirmation and both steps", async function () {
    var previous = await Project.findById(people[0].project._id);
    await post(admin, adminRoot + "/projects/" + previous.id + "/undo-table").expect(200);
    var cleared = await Project.findById(previous._id);
    assert.equal(cleared.tableNumber, undefined);
    assert.equal(String(cleared.tableUndoLog[0].by), admin.user.id);
    assert.ok(cleared.tableUndoLog[0].at);
    var assigned = await post(moderator, desk, { userId: people[0].user.id }).expect(200);
    assert.equal(assigned.body.project.tableNumber, previous.tableNumber);
    var preview = await post(admin, adminRoot + "/bulk-assign").expect(409);
    assert.equal(preview.body.count, 21);
    await post(admin, adminRoot + "/bulk-assign", { confirm: true, count: 999 }).expect(409);
    await post(admin, adminRoot + "/bulk-assign", { confirm: true, count: preview.body.count }).expect(200);
    assert.equal(await Project.countDocuments({ tableCheckedInAt: { $exists: true } }), 21);
  });
  await t.test("permissions and disabled feature", async function () {
    await request(app).post(desk).send({ userId: people[0].user.id }).expect(401);
    await post(people[0], desk, { userId: people[0].user.id }).expect(403);
    await post(judge, "/api/judging/table-checkin", { token: "a".repeat(64) }).expect(403);
    await post(moderator, adminRoot + "/bulk-assign").expect(403);
    await post(moderator, adminRoot + "/projects/" + people[0].project.id + "/undo-table").expect(403);
    await request(app).get(adminRoot + "/table-signs").set(auth(moderator)).expect(403);
    await request(app).patch("/api/admin/settings").set(auth(admin)).send({ features: { judging: false } }).expect(200);
    await post(admin, desk, { userId: people[0].user.id }).expect(404);
    await post(people[0], "/api/judging/table-checkin", { token: "a".repeat(64) }).expect(404);
  });
});
