"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Application = require("../schemas/application");
var Assignment = require("../schemas/judgingAssignment");
var Profile = require("../schemas/judgeProfile");
var Project = require("../schemas/project");
var Room = require("../schemas/judgingRoom");
var Score = require("../schemas/judgingScore");
var State = require("../schemas/judgingState");
var Team = require("../schemas/team");
var User = require("../schemas/user");
var normalize = require("../controllers/teamController").normalizeDevpostUrl;

var adminRoot = "/api/admin/judging";
function auth(person) { return { Authorization: "Bearer " + person.token }; }
function post(person, path, body) { return request(app).post(path).set(auth(person)).send(body || {}); }
function upload(person, csv) {
  return request(app).post(adminRoot + "/import").set(auth(person)).attach("file", Buffer.from(csv), "devpost.csv");
}
function ids(list) { return list.map(String); }

// Header row exactly as the Devpost project export writes it (custom questions keep the organizer's wording).
var HEADER = "Project Title,Submission Url,Project Status,Opt-In Prizes,Submitter First Name,Submitter Last Name,Submitter Email," +
  "Choose A Demo Hack Judging Category:,Do You Wish To Be Judged By Hardware Judges?," +
  "Team Member 1 First Name,Team Member 1 Last Name,Team Member 1 Email";
function csvRow(cells) { return cells.map(function quote(c) { return /[",]/.test(c) ? "\"" + c.replace(/"/g, "\"\"") + "\"" : c; }).join(","); }

test("Devpost submission links normalize to the project page", function () {
  assert.equal(normalize("https://demo-hack.devpost.com/submissions/1301786-Centsible"), "https://devpost.com/software/centsible");
  assert.equal(normalize("demo-hack.devpost.com/submissions/12-my-app/?ref=x"), "https://devpost.com/software/my-app");
  assert.equal(normalize("https://devpost.com/software/my-app"), "https://devpost.com/software/my-app");
  assert.equal(normalize("https://demo-hack.devpost.com/submissions/no-id"), null);
  assert.equal(normalize("https://demo-hack.devpost.com/"), null);
});

test("Devpost import, judge eligibility, moving tables and the team sheet", async function (t) {
  await db.connect();
  t.after(db.closeDatabase);
  await db.clearDatabase();
  var admin = await fixtures.createUser({ role: "admin" });

  await t.test("import links teams by Devpost link, then email, then unique name; reads hardware, category and MLH", async function () {
    var linkLead = await fixtures.createUser({ email: "link@example.com", name: "Link Lead" });
    var emailLead = await fixtures.createUser({ email: "email@example.com", name: "Email Lead" });
    var nameLead = await fixtures.createUser({ email: "dashboard-name@example.com", name: "Nina  Named" });
    var nameMate = await fixtures.createUser({ email: "mate@example.com", name: "Mate Named" });
    await fixtures.createUser({ email: "twin1@example.com", name: "Sam Same" });
    await fixtures.createUser({ email: "twin2@example.com", name: "Sam Same" });
    var linkTeam = await Team.create({ name: "Link team", nameKey: "link team", leader: linkLead.user._id, members: [linkLead.user._id], devpostUrl: "https://devpost.com/software/linked-app" });
    var emailTeam = await Team.create({ name: "Email team", nameKey: "email team", leader: emailLead.user._id, members: [emailLead.user._id] });
    var nameTeam = await Team.create({ name: "Name team", nameKey: "name team", leader: nameLead.user._id, members: [nameLead.user._id, nameMate.user._id] });
    var csv = [HEADER,
      csvRow(["Linked App", "https://demo-hack.devpost.com/submissions/111-linked-app", "Submitted (Gallery/Visible)", "[MLH] Best Use of Gemini API, Sponsor Prize", "Someone", "Else", "not-registered@example.com", "[DEMO] [SOFTWARE] Best Beginner Hack", "No", "", "", ""]),
      csvRow(["Email App", "https://demo-hack.devpost.com/submissions/222-email-app", "Submitted (Gallery/Visible)", "Sponsor Prize", "Email", "Lead", "EMAIL@example.com", "[DEMO] [HARDWARE] Best Hardware Hack", "Yes", "", "", ""]),
      csvRow(["Name App", "https://demo-hack.devpost.com/submissions/333-name-app", "Submitted (Gallery/Visible)", "", "nina", "named", "other-address@example.com", "Best Design", "", "Sam", "Same", "twin-other@example.com"]),
    ].join("\n");
    var response = await upload(admin, csv);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    var preview = response.body.preview;
    assert.deepEqual(preview.counts, { new: 3, updated: 0, unchanged: 0, errors: 0 });
    assert.deepEqual(preview.unrecognizedColumns, ["Project Status"]);
    var byName = Object.fromEntries(preview.rows.map(function row(r) { return [r.project.name, r]; }));
    var linked = byName["Linked App"];
    assert.equal(linked.project.devpostUrl, "https://devpost.com/software/linked-app");
    assert.equal(String(linked.matchedTeam.id), String(linkTeam._id));
    assert.deepEqual(linked.project.mlhTracks, ["[MLH] Best Use of Gemini API"]);
    assert.equal(linked.project.category, "[DEMO] [SOFTWARE] Best Beginner Hack");
    assert.equal(linked.project.hardware, false);
    var email = byName["Email App"];
    assert.equal(String(email.matchedTeam.id), String(emailTeam._id));
    assert.equal(email.project.hardware, true);
    assert.deepEqual(email.project.mlhTracks, []);
    var named = byName["Name App"];
    assert.equal(String(named.matchedTeam.id), String(nameTeam._id), "unique name match finds the team");
    assert.deepEqual(ids(named.project.members).sort(), ids([nameLead.user._id, nameMate.user._id]).sort());
    assert.ok(named.warnings.some(function w(x) { return /Matched by name/.test(x) && /nina named/.test(x); }));
    // "Sam Same" belongs to two accounts, so the name is never guessed.
    assert.deepEqual(named.unmatchedMembers, [{ name: "Sam Same", email: "twin-other@example.com" }]);
    await post(admin, adminRoot + "/import/" + response.body.id + "/confirm").expect(200);
    var saved = await Project.findOne({ name: "Linked App" }).lean();
    assert.equal(String(saved.team), String(linkTeam._id));
    assert.ok(ids(saved.members).includes(String(linkLead.user._id)));
  });

  await t.test("judges who have not accepted their invite are left out; admins on the judges tab count", async function () {
    await Project.deleteMany({});
    var room = await Room.create({ name: "Hall", order: 1, capacity: 6 });
    for (var n = 1; n <= 4; n++) {
      await Project.create({ name: "P" + n, devpostUrl: "https://devpost.com/software/p" + n, room: room._id, tableNumber: n, deskCheckedInAt: new Date(), tableCheckedInAt: new Date() });
    }
    var accepted = await fixtures.createUser({ role: "judge" });
    var pending = await fixtures.createUser({ role: "judge" });
    await User.updateOne({ _id: pending.user._id }, { $set: { judgeInvitePending: true } });
    var adminJudge = await fixtures.createUser({ role: "admin" });
    await Profile.create([{ user: accepted.user._id }, { user: pending.user._id }, { user: adminJudge.user._id }]);
    var result = await post(admin, adminRoot + "/assignments", { judgingsPerProject: 1 }).expect(201);
    var judges = ids(result.body.assignment.queues.map(function q(x) { return x.judge; })).sort();
    assert.deepEqual(judges, ids([accepted.user._id, adminJudge.user._id]).sort());
    var lateProject = (await Project.findOne({ tableNumber: 1 }))._id;
    await post(admin, adminRoot + "/assignments/" + result.body.assignment.version + "/activate").expect(200);
    var late = await post(admin, adminRoot + "/assignments/judges", { judgeId: pending.user.id, projectIds: [String(lateProject)] }).expect(404);
    assert.match(late.body.error, /accepted their invite/);
    await Profile.deleteMany({});
    await Assignment.deleteMany({});
    await State.updateOne({ _id: "judging" }, { $set: { activeVersion: null } });
  });

  await t.test("moving a table range: specific judge, conflicts, auto, hardware and apply", async function () {
    await Project.deleteMany({});
    await Room.deleteMany({});
    var hall = await Room.create({ name: "Hall", order: 1, capacity: 20 });
    var lab = await Room.create({ name: "Lab", order: 2, capacity: 5, hardware: true });
    var p = {};
    for (var n = 1; n <= 12; n++) {
      p[n] = (await Project.create({ name: "P" + n, devpostUrl: "https://devpost.com/software/m" + n, room: hall._id, tableNumber: n, deskCheckedInAt: new Date(), tableCheckedInAt: new Date() }))._id;
    }
    p[21] = (await Project.create({ name: "H21", devpostUrl: "https://devpost.com/software/m21", hardware: true, room: lab._id, tableNumber: 21, deskCheckedInAt: new Date(), tableCheckedInAt: new Date() }))._id;
    async function judge(name, hardware) {
      var person = await fixtures.createUser({ role: "judge", name: name });
      await Profile.create({ user: person.user._id, hardware: Boolean(hardware) });
      return person;
    }
    var A = await judge("Alpha", true);
    var B = await judge("Bravo");
    var C = await judge("Charlie");
    var D = await judge("Delta");
    var pending = await judge("Pending");
    await User.updateOne({ _id: pending.user._id }, { $set: { judgeInvitePending: true } });
    function q(person, tables) { return { judge: person.user._id, projects: tables.map(function id(n) { return p[n]; }), slots: tables.map(function id(n) { return p[n]; }), skipped: [] }; }
    await Assignment.create({ version: 7, createdBy: admin.user._id, params: { judgingsPerProject: 1 },
      queues: [q(A, [1, 2, 3, 4, 5, 6, 21]), q(B, [7, 8, 4]), q(C, [9, 10, 11]), q(D, [12])] });
    await State.updateOne({ _id: "judging" }, { $set: { activeVersion: 7 } }, { upsert: true });
    // A already scored table 3; C scored table 5 before (it is not in C's queue).
    await Score.collection.insertMany([{ judge: A.user._id, project: p[3] }, { judge: C.user._id, project: p[5] }]);
    var plan = "/assignments/move/plan";

    await post(admin, adminRoot + plan, { fromJudgeId: A.user.id, tableFrom: 6, tableTo: 2, toJudgeId: B.user.id }).expect(400);
    await post(admin, adminRoot + plan, { fromJudgeId: A.user.id, tableFrom: 3, tableTo: 3 }).expect(400);
    await post(admin, adminRoot + plan, { fromJudgeId: A.user.id, tableFrom: 2, tableTo: 6, toJudgeId: pending.user.id }).expect(404);

    var specific = (await post(admin, adminRoot + plan, { fromJudgeId: A.user.id, tableFrom: 2, tableTo: 6, toJudgeId: B.user.id }).expect(200)).body.moves;
    assert.deepEqual(specific.map(function t(m) { return m.tableNumber; }), [2, 4, 5, 6], "scored table 3 stays");
    var row4 = specific.find(function f(m) { return m.tableNumber === 4; });
    assert.match(row4.conflict, /Bravo has already seen/);
    assert.notEqual(row4.judgeId, B.user.id);
    assert.ok(!row4.alternatives.some(function bravo(a) { return a.judgeId === B.user.id; }));
    specific.filter(function ok(m) { return m.tableNumber !== 4; }).forEach(function toB(m) { assert.equal(m.judgeId, B.user.id); assert.equal(m.conflict, null); });

    var auto = (await post(admin, adminRoot + plan, { fromJudgeId: A.user.id, tableFrom: 5, tableTo: 6 }).expect(200)).body.moves;
    // C saw table 5, B (3 left) and D (1 left) saw neither: the least-busy judge who saw none takes both.
    assert.deepEqual(auto.map(function j(m) { return m.judgeId; }), [D.user.id, D.user.id]);

    var hardware = (await post(admin, adminRoot + plan, { fromJudgeId: A.user.id, tableFrom: 21, tableTo: 21, toJudgeId: B.user.id }).expect(200)).body.moves;
    assert.match(hardware[0].conflict, /not a hardware judge/);
    assert.equal(hardware[0].judgeId, null, "no other hardware judge exists");

    var apply = "/assignments/move";
    // Any invalid row rejects the whole move.
    var rejected = await post(admin, adminRoot + apply, { fromJudgeId: A.user.id, moves: [{ projectId: String(p[2]), judgeId: B.user.id }, { projectId: String(p[4]), judgeId: B.user.id }] }).expect(409);
    assert.match(rejected.body.error, /Table 4: Bravo has already seen/);
    await post(admin, adminRoot + apply, { fromJudgeId: A.user.id, moves: [{ projectId: String(p[3]), judgeId: B.user.id }] }).expect(409);
    await post(admin, adminRoot + apply, { fromJudgeId: A.user.id, moves: [{ projectId: String(p[21]), judgeId: B.user.id }] }).expect(409);
    await post(admin, adminRoot + apply, { fromJudgeId: A.user.id, moves: [{ projectId: String(p[5]), judgeId: pending.user.id }] }).expect(409);
    var unchanged = await Assignment.findOne({ version: 7 }).lean();
    assert.equal(unchanged.queues[0].projects.length, 7);

    await post(admin, adminRoot + apply, { fromJudgeId: A.user.id, moves: [
      { projectId: String(p[6]), judgeId: B.user.id }, { projectId: String(p[2]), judgeId: B.user.id }, { projectId: String(p[4]), judgeId: C.user.id },
    ] }).expect(200);
    var after = await Assignment.findOne({ version: 7 }).lean();
    function queueOf(person) { return after.queues.find(function same(x) { return String(x.judge) === person.user.id; }); }
    assert.deepEqual(ids(queueOf(A).projects), ids([p[1], p[3], p[5], p[21]]));
    assert.deepEqual(ids(queueOf(A).slots), ids([p[1], null, p[3], null, p[5], null, p[21]]).map(function n(x) { return x === "null" ? "null" : x; }));
    assert.deepEqual(ids(queueOf(B).projects), ids([p[7], p[8], p[4], p[2], p[6]]), "appended in table order");
    assert.deepEqual(ids(queueOf(C).projects), ids([p[9], p[10], p[11], p[4]]));
    assert.ok(after.sheetLabels.length >= 4);
  });

  await t.test("team sheet: MLH flag and members without a team link find their project", async function () {
    var person = await fixtures.createUser({ email: "solo@example.com" });
    await Application.create({ applicant: person.user._id, status: "accepted" });
    var room = await Room.findOne({ name: "Hall" });
    await Project.create({ name: "Solo", devpostUrl: "https://devpost.com/software/solo", members: [person.user._id], room: room._id, tableNumber: 15, mlhTracks: ["[MLH] Best Use of Gemini API"] });
    await post(admin, adminRoot + "/open").expect(200);
    var sheet = await request(app).get("/api/judging/sheet").set(auth(person)).expect(200);
    assert.equal(sheet.body.ownTeam.table, 15);
    assert.equal(sheet.body.ownTeam.mlh, true);
    await Project.updateOne({ name: "Solo" }, { $set: { mlhTracks: [] } });
    sheet = await request(app).get("/api/judging/sheet").set(auth(person)).expect(200);
    assert.equal(sheet.body.ownTeam.mlh, false);
  });

  await t.test("judging desk lists teams with a table who have not scanned in at it", async function () {
    var moderator = await fixtures.createUser({ role: "moderator" });
    var waiting = await fixtures.createUser({ name: "Waiting Person" });
    var room = await Room.findOne({ name: "Hall" });
    await Project.create({ name: "Waiting", devpostUrl: "https://devpost.com/software/waiting", members: [waiting.user._id], room: room._id, tableNumber: 16, deskCheckedInAt: new Date() });
    await Project.create({ name: "Not yet at desk", devpostUrl: "https://devpost.com/software/not-yet" });
    var list = (await request(app).get("/api/staff/judging/awaiting-table").set(auth(moderator)).expect(200)).body.projects;
    assert.deepEqual(list.map(function n(x) { return x.name; }), ["Waiting"]);
    assert.equal(list[0].room, "Hall");
    assert.deepEqual(list[0].members, ["Waiting Person"]);
    assert.equal(Object.keys(list[0]).some(function k(key) { return /email|qr/i.test(key); }), false);
  });
});
