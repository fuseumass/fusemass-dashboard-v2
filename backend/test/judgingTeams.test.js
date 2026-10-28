"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Team = require("../schemas/team");
var Project = require("../schemas/project");
var Room = require("../schemas/judgingRoom");
var Application = require("../schemas/application");
var Assignment = require("../schemas/judgingAssignment");
var Score = require("../schemas/judgingScore");
var Settings = require("../schemas/judgingSettings");
var OrgSettings = require("../schemas/orgSettings");
var State = require("../schemas/judgingState");
var mailer = require("../utils/mailer");
var control = require("../utils/judging/state");
var root = "/api/admin/judging";
var lockedMessage = "Your team is checked in for judging. Ask at the help desk to change your team.";
function call(person, method, path, body) {
  return request(app)[method](path).set("Authorization", "Bearer " + person.token).send(body || {});
}
async function accepted() {
  var person = await fixtures.createUser();
  await Application.create({ applicant: person.user._id, status: "accepted" });
  person.user.qrId = await require("../schemas/user").ensureQrId(person.user._id);
  return person;
}
async function makeTeam(name, people) {
  return Team.create({ name: name, nameKey: name.toLowerCase(), leader: people[0].user._id, members: people.map(function id(p) { return p.user._id; }) });
}
async function preview(admin, rows) {
  var csv = "Project name,Submission URL,Submitter email,Team member 1 email\n" + rows.join("\n");
  return request(app).post(root + "/import").set("Authorization", "Bearer " + admin.token).attach("file", Buffer.from(csv), "projects.csv").expect(200);
}

test("judging teams integration", async function suite(t) {
  await db.connect();
  t.after(db.closeDatabase);
  await db.clearDatabase();
  var admin = await fixtures.createUser({ role: "admin" });
  var staff = await fixtures.createUser({ role: "moderator" });
  var mails = [];
  t.mock.method(mailer, "sendTemplateEmail", function email(to, key, values) { mails.push({ to: to, key: key, values: values }); return Promise.resolve(); });
  var a = await accepted();
  var b = await accepted();
  var c = await accepted();
  var d = await accepted();
  var alpha = await makeTeam("Alpha", [a, b]);
  var beta = await makeTeam("Beta", [c]);
  var url = "https://devpost.com/software/alpha";
  var project;

  await t.test("import combines current members, matches URL first and warns across teams", async function () {
    await Team.updateOne({ _id: alpha._id }, { $set: { devpostUrl: url } });
    var response = await preview(admin, ["Build," + url + "," + c.user.email + "," + a.user.email]);
    var row = response.body.preview.rows[0];
    assert.equal(row.matchedTeam.name, "Alpha");
    assert.deepEqual(new Set(row.project.members), new Set([a.user.id, b.user.id, c.user.id]));
    assert.match(row.warnings[0], /Alpha/);
    assert.match(row.warnings[0], /Beta/);
    await call(admin, "post", root + "/import/" + response.body.id + "/confirm").expect(200);
    project = await Project.findOne({ devpostUrl: url });
    assert.equal(String(project.team), alpha.id);
  });
  await t.test("two CSV submissions for one team are errors and neither is imported", async function () {
    var response = await preview(admin, ["One,https://devpost.com/software/one," + c.user.email + ",", "Two,https://devpost.com/software/two," + c.user.email + ","]);
    assert.equal(response.body.preview.counts.errors, 2);
    assert.equal(response.body.preview.rows.filter(function invalid(row) { return row.status === "error"; }).length, 2);
    assert.match(response.body.preview.errors[0].reason, /Team Beta has two submissions: One and Two/);
    await call(admin, "post", root + "/import/" + response.body.id + "/confirm").expect(200);
    assert.equal(await Project.countDocuments({ team: beta._id }), 0);
  });
  await t.test("email fallback and reimport preserve the existing link", async function () {
    await Team.updateOne({ _id: alpha._id }, { $unset: { devpostUrl: 1 } });
    var response = await preview(admin, ["Renamed," + url + "," + d.user.email + ","]);
    assert.equal(response.body.preview.rows[0].matchedTeam.name, "Alpha");
    await call(admin, "post", root + "/import/" + response.body.id + "/confirm").expect(200);
    assert.equal(String((await Project.findById(project._id)).team), alpha.id);
    var fallback = await preview(admin, ["Fallback,https://devpost.com/software/fallback," + c.user.email + ","]);
    assert.equal(fallback.body.preview.rows[0].matchedTeam.name, "Beta");
  });
  await t.test("admin override validates uniqueness and can clear a team", async function () {
    var extra = await Project.create({ name: "Extra", devpostUrl: "https://devpost.com/software/extra" });
    await call(admin, "patch", root + "/projects/" + extra.id, { team: alpha.id }).expect(409);
    await call(admin, "patch", root + "/projects/" + extra.id, { team: "invalid" }).expect(400);
    await call(admin, "patch", root + "/projects/" + extra.id, { team: beta.id }).expect(200);
    await call(admin, "patch", root + "/projects/" + extra.id, { team: null }).expect(200);
    assert.equal((await Project.findById(extra.id)).team, undefined);
    await extra.deleteOne();
  });
  var room = await Room.create({ name: "Software room", order: 1, capacity: 8 });
  await t.test("desk check-in locks the team before the project table write", async function (sub) {
    var update = Project.findOneAndUpdate.bind(Project);
    sub.mock.method(Project, "findOneAndUpdate", async function assertLocked(filter, changes, options) {
      if (changes.$set && changes.$set.tableNumber) assert.ok((await Team.findById(alpha.id).session(options.session)).lockedAt);
      return update(filter, changes, options);
    });
    await call(staff, "post", "/api/staff/judging/desk-checkin", { userId: a.user.id }).expect(200);
    var team = await Team.findById(alpha.id);
    assert.ok(team.lockedAt);
    assert.equal(String(team.lockedBy), staff.user.id);
    assert.ok((await Project.findById(project.id)).tableNumber);
  });
  await t.test("all self-service mutations return 423 and reads remain available", async function () {
    await Team.updateOne({ _id: alpha._id }, { $push: { invites: { email: d.user.email, invitedBy: a.user._id } } });
    await Team.updateOne({ _id: beta._id }, { $push: { invites: { email: a.user.email, invitedBy: c.user._id } } });
    var paths = [
      [a, "post", "/api/teams/me/leave"],
      [a, "delete", "/api/teams/me/members/" + b.user.id],
      [a, "post", "/api/teams/me/invites", { email: "someone@example.com" }],
      [a, "delete", "/api/teams/me/invites/" + encodeURIComponent(d.user.email)],
      [d, "post", "/api/teams/invites/" + alpha.id + "/accept"],
      [a, "post", "/api/teams/invites/" + beta.id + "/accept"],
      [a, "post", "/api/teams", { name: "Another" }],
      [a, "patch", "/api/teams/me", { name: "Rename" }],
      [b, "patch", "/api/teams/me", { devpostUrl: "" }],
    ];
    for (var args of paths) {
      var response = await call.apply(null, args).expect(423);
      assert.equal(response.body.error, lockedMessage);
    }
    var mine = await call(a, "get", "/api/teams/me").expect(200);
    assert.ok(mine.body.team.lockedAt);
    assert.equal((await Team.findById(alpha.id)).members.length, 2);
  });
  await t.test("staff mutate locked teams, synchronize members, log actors and enforce capacity", async function () {
    var staffRoot = "/api/staff/teams/" + alpha.id;
    await call(staff, "delete", staffRoot + "/invites/" + encodeURIComponent(d.user.email)).expect(200);
    await call(staff, "post", staffRoot + "/invites", { email: d.user.email }).expect(200);
    assert.ok(mails.some(function invite(mail) { return mail.to === d.user.email && mail.key === "team_invite" && mail.values.inviterName === staff.user.name; }));
    await call(staff, "post", staffRoot + "/members", { qrId: d.user.qrId }).expect(200);
    await call(staff, "post", staffRoot + "/members", { userId: c.user.id }).expect(409);
    var settings = await OrgSettings.getSingleton();
    settings.teamMaxSize = 3;
    await settings.save();
    var extra = await accepted();
    await call(staff, "post", staffRoot + "/members", { userId: extra.user.id }).expect(400);
    await call(staff, "post", staffRoot + "/invites", { email: extra.user.email }).expect(400);
    await call(staff, "delete", staffRoot + "/members/" + b.user.id).expect(200);
    var current = await Team.findById(alpha.id);
    assert.ok(current.lockedAt);
    assert.deepEqual((await Project.findById(project.id)).members.map(String), current.members.map(String));
    assert.deepEqual(current.staffChanges.map(function action(change) { return change.action; }), ["cancelInvite", "invite", "add", "remove"]);
    current.staffChanges.forEach(function actor(change) { assert.equal(String(change.by), staff.user.id); assert.ok(change.at); });
    var lookup = await call(staff, "post", "/api/staff/teams/lookup", { qrId: a.user.qrId }).expect(200);
    assert.equal(lookup.body.team.project.tableNumber, 1);
    assert.equal(JSON.stringify(lookup.body).includes(a.user.qrId), false);
  });
  await t.test("undo and explicit admin unlock reopen membership; bulk fallback locks too", async function () {
    await call(admin, "post", root + "/projects/" + project.id + "/undo-table").expect(200);
    assert.equal((await Team.findById(alpha.id)).lockedAt, undefined);
    await call(a, "patch", "/api/teams/me", { name: "Alpha renamed" }).expect(200);
    var pending = await Project.countDocuments({ withdrawn: false, $or: [{ deskCheckedInAt: null }, { tableCheckedInAt: null }] });
    await call(admin, "post", root + "/bulk-assign", { confirm: true, count: pending }).expect(200);
    assert.ok((await Team.findById(alpha.id)).lockedAt);
    await call(staff, "post", "/api/admin/teams/" + alpha.id + "/unlock").expect(403);
    await call(admin, "post", "/api/admin/teams/" + alpha.id + "/unlock").expect(200);
    await call(a, "patch", "/api/teams/me", { devpostUrl: url }).expect(200);
  });
  await t.test("participant sheet separates pools, counts current locations and hides identity", async function () {
    var hardwareRoom = await Room.create({ name: "Hardware room", order: 0, capacity: 2, hardware: true });
    var hp = await Project.create({ name: "Hardware build", devpostUrl: "https://devpost.com/software/hardware-build", hardware: true, room: hardwareRoom._id, tableNumber: 9 });
    var next = await Project.create({ name: "Next", devpostUrl: "https://devpost.com/software/next", room: room._id, tableNumber: 2 });
    var judges = [];
    for (var i = 0; i < 3; i++) judges.push(await fixtures.createUser({ role: "judge", name: "Private judge " + i }));
    await Assignment.create({ version: 1, createdBy: admin.user._id, queues: [
      { judge: judges[0].user._id, projects: [project._id, next._id], slots: [project._id, next._id], skipped: [] },
      { judge: judges[1].user._id, projects: [project._id], slots: [project._id], skipped: [] },
      { judge: judges[2].user._id, projects: [hp._id], slots: [hp._id], skipped: [] },
    ] });
    await control.getState();
    await State.updateOne({ _id: "judging" }, { $set: { activeVersion: 1 } });
    await Settings.updateOne({ key: "default" }, { $set: { judgingOpen: true } });
    await Score.create({ judge: judges[1].user._id, project: project._id, scores: { innovation: 5 } });
    var sheet = await call(a, "get", "/api/judging/sheet").expect(200);
    assert.equal(sheet.body.software[0].name, room.name);
    assert.equal(sheet.body.hardware[0].name, hardwareRoom.name);
    assert.equal(sheet.body.software[0].judgeCount, 1);
    assert.equal(sheet.body.hardware[0].judgeCount, 1);
    assert.equal(sheet.body.software[0].judges[0].table, 1);
    assert.equal(sheet.body.ownTeam.done, 1);
    assert.equal(sheet.body.ownTeam.assigned, 2);
    var json = JSON.stringify(sheet.body);
    judges.forEach(function privateJudge(judge) { [judge.user.name, judge.user.email, judge.user.id].forEach(function secret(value) { assert.equal(json.includes(value), false); }); });
    assert.equal(/scores|comments|skipped|projects|_id/.test(json), false);
    var softwareLabel = sheet.body.software[0].judges[0].label;
    await Score.create({ judge: judges[0].user._id, project: project._id, scores: { innovation: 7 } });
    var moved = await call(a, "get", "/api/judging/sheet").expect(200);
    assert.equal(moved.body.software[0].judges[0].table, 2);
    assert.equal(moved.body.software[0].judges[0].label, softwareLabel);
    assert.equal(moved.body.ownTeam.done, 2);
    var label = sheet.body.hardware[0].judges[0].label;
    await Assignment.updateOne({ version: 1 }, { $pull: { queues: { judge: judges[0].user._id } } });
    var again = await call(a, "get", "/api/judging/sheet").expect(200);
    assert.equal(again.body.hardware[0].judges[0].label, label);
    await call(judges[0], "get", "/api/judging/sheet").expect(403);
    var unaccepted = await fixtures.createUser();
    await call(unaccepted, "get", "/api/judging/sheet").expect(403);
    await call(staff, "get", "/api/judging/sheet").expect(200);
    await Settings.updateOne({ key: "default" }, { $set: { judgingOpen: false } });
    assert.deepEqual((await call(a, "get", "/api/judging/sheet").expect(200)).body, { open: false });
  });
  await t.test("new team and sheet endpoints respect the judging feature flag", async function () {
    await call(admin, "patch", "/api/admin/settings", { features: { judging: false } }).expect(200);
    for (var route of [
      [staff, "post", "/api/staff/teams/lookup", { userId: a.user.id }],
      [staff, "post", "/api/staff/teams/" + alpha.id + "/invites", { email: "extra@example.com" }],
      [staff, "delete", "/api/staff/teams/" + alpha.id + "/invites/extra@example.com"],
      [staff, "post", "/api/staff/teams/" + alpha.id + "/members", { userId: b.user.id }],
      [staff, "delete", "/api/staff/teams/" + alpha.id + "/members/" + d.user.id],
      [admin, "post", "/api/admin/teams/" + alpha.id + "/unlock"],
      [a, "get", "/api/judging/sheet"],
    ]) await call.apply(null, route).expect(404);
  });
});
