"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Assignment = require("../schemas/judgingAssignment");
var Project = require("../schemas/project");
var ProjectImport = require("../schemas/projectImport");
var Room = require("../schemas/judgingRoom");
var Score = require("../schemas/judgingScore");
var State = require("../schemas/judgingState");
var Team = require("../schemas/team");

var root = "/api/admin/judging";
function auth(person) { return { Authorization: "Bearer " + person.token }; }
function csvRows(text) {
  return text.trim().split(/\r?\n/);
}

test("judging projects: CSV export and delete all", async function (t) {
  await db.connect();
  t.after(db.closeDatabase);
  await db.clearDatabase();
  var admin = await fixtures.createUser({ role: "admin" });
  var moderator = await fixtures.createUser({ role: "moderator" });
  var lead = await fixtures.createUser({ name: "Lead Person", email: "lead@example.com" });
  var mate = await fixtures.createUser({ name: "Mate Person", email: "mate@example.com" });
  var room = await Room.create({ name: "Room A", order: 1, tableStart: 1, tableEnd: 10, capacity: 10 });
  var team = await Team.create({ name: "Team One", nameKey: "team one", leader: lead.user._id, members: [lead.user._id, mate.user._id], lockedAt: new Date() });
  await Project.create({ name: "No Table", devpostUrl: "https://devpost.com/software/no-table" });
  await Project.create({
    name: "=HYPERLINK(\"http://evil\")", devpostUrl: "https://devpost.com/software/one", team: team._id, members: [lead.user._id, mate.user._id],
    submitterEmail: "lead@example.com", category: "[X] Best Hack", optInPrizes: ["[MLH] A", "Other"], mlhTracks: ["[MLH] A"],
    hardware: true, room: room._id, tableNumber: 7, deskCheckedInAt: new Date("2026-11-15T15:00:00Z"),
    unmatchedMembers: [{ name: "Ghost", email: "ghost@example.com" }],
  });
  await Project.create({ name: "Table Two", devpostUrl: "https://devpost.com/software/two", room: room._id, tableNumber: 2 });

  await t.test("export has every imported field, sorted by table, formula-safe", async function () {
    await request(app).get(root + "/projects.csv").set(auth(moderator)).expect(403);
    var res = await request(app).get(root + "/projects.csv").set(auth(admin)).expect(200);
    assert.match(res.headers["content-type"], /text\/csv/);
    assert.match(res.headers["content-disposition"], /judging-projects/);
    var lines = csvRows(res.text);
    assert.match(lines[0], /^﻿?Project,Devpost URL,Table,Room,Hardware,Category,Opt-in prizes,MLH tracks,Needs power,Dashboard team,Team leader,Members,Member emails,Submitter email,Unmatched people,Desk check-in,Table check-in,Withdrawn$/);
    assert.equal(lines.length, 4);
    assert.match(lines[1], /^Table Two,https:\/\/devpost\.com\/software\/two,2,Room A,/);
    assert.match(lines[2], /^"'=HYPERLINK\(""http:\/\/evil""\)",https:\/\/devpost\.com\/software\/one,7,Room A,true,\[X\] Best Hack,\[MLH\] A; Other,\[MLH\] A,false,Team One,Lead Person,Lead Person; Mate Person,lead@example\.com; mate@example\.com,lead@example\.com,Ghost <ghost@example\.com>,2026-11-15T15:00:00\.000Z,,false$/);
    assert.match(lines[3], /^No Table,https:\/\/devpost\.com\/software\/no-table,,,false,/);
    assert.doesNotMatch(res.text, /qrId|passwordHash/);
  });

  await t.test("delete all needs the exact count, closed judging and no scores", async function () {
    await request(app).post(root + "/projects/delete-all").set(auth(moderator)).send({ confirm: true, count: 3 }).expect(403);
    var preview = await request(app).post(root + "/projects/delete-all").set(auth(admin)).send({}).expect(409);
    assert.equal(preview.body.count, 3);
    await request(app).post(root + "/projects/delete-all").set(auth(admin)).send({ confirm: true, count: 2 }).expect(409);
    await request(app).post(root + "/open").set(auth(admin)).expect(200);
    var open = await request(app).post(root + "/projects/delete-all").set(auth(admin)).send({ confirm: true, count: 3 }).expect(409);
    assert.match(open.body.error, /Close judging/);
    await request(app).post(root + "/close").set(auth(admin)).expect(200);
    var judge = await fixtures.createUser({ role: "judge" });
    var scored = await Score.collection.insertOne({ judge: judge.user._id, project: (await Project.findOne({ tableNumber: 2 }))._id });
    var blocked = await request(app).post(root + "/projects/delete-all").set(auth(admin)).send({ confirm: true, count: 3 }).expect(409);
    assert.match(blocked.body.error, /already scored/);
    await Score.collection.deleteOne({ _id: scored.insertedId });
    assert.equal(await Project.countDocuments({}), 3);
  });

  await t.test("delete all clears projects, draft assignments and previews; keeps rooms; unlocks teams", async function () {
    var project = await Project.findOne({ tableNumber: 7 });
    await Assignment.create({ version: 1, createdBy: admin.user._id, params: { judgingsPerProject: 1 }, queues: [{ judge: admin.user._id, projects: [project._id], slots: [project._id], skipped: [] }] });
    await State.updateOne({ _id: "judging" }, { $set: { activeVersion: 1 } }, { upsert: true });
    await ProjectImport.create({ createdBy: admin.user._id, expiresAt: new Date(Date.now() + 60000), preview: { rows: [] } });
    var done = await request(app).post(root + "/projects/delete-all").set(auth(admin)).send({ confirm: true, count: 3 }).expect(200);
    assert.equal(done.body.deleted, 3);
    assert.equal(await Project.countDocuments({}), 0);
    assert.equal(await Assignment.countDocuments({}), 0);
    assert.equal((await State.findById("judging").lean()).activeVersion, null);
    assert.equal(await ProjectImport.countDocuments({}), 0);
    assert.equal(await Room.countDocuments({}), 1);
    assert.equal((await Team.findById(team._id)).lockedAt, undefined);
    var empty = await request(app).get(root + "/projects.csv").set(auth(admin)).expect(200);
    assert.equal(csvRows(empty.text).length, 1);
  });
});
