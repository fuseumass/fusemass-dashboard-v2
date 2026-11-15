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

test("room table ranges set the numbering; room order sets the walk", function () {
  var allocator = require("../utils/judging/tables");
  var slots = allocator.layout([
    { _id: "far", tableStart: 20, tableEnd: 22, capacity: 3 },
    { _id: "near", tableStart: 1, tableEnd: 2, capacity: 2 },
    { _id: "legacy", capacity: 2 },
  ]);
  assert.deepEqual(slots.map(function n(x) { return x.number; }), [20, 21, 22, 1, 2, 23, 24]);
  assert.deepEqual(slots.map(function r(x) { return x.room; }), ["far", "far", "far", "near", "near", "legacy", "legacy"]);
});

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
    // Devpost project pages carry a random suffix the submission link lacks.
    var linkTeam = await Team.create({ name: "Link team", nameKey: "link team", leader: linkLead.user._id, members: [linkLead.user._id], devpostUrl: "https://devpost.com/software/linked-app-c2v0rz" });
    var twinA = await fixtures.createUser({ email: "twin-a@example.com" });
    var twinB = await fixtures.createUser({ email: "twin-b@example.com" });
    await Team.create({ name: "Twin A", nameKey: "twin a", leader: twinA.user._id, members: [twinA.user._id], devpostUrl: "https://devpost.com/software/twin-app-aaaaaa" });
    await Team.create({ name: "Twin B", nameKey: "twin b", leader: twinB.user._id, members: [twinB.user._id], devpostUrl: "https://devpost.com/software/twin-app-bbbbbb" });
    var emailTeam = await Team.create({ name: "Email team", nameKey: "email team", leader: emailLead.user._id, members: [emailLead.user._id] });
    var nameTeam = await Team.create({ name: "Name team", nameKey: "name team", leader: nameLead.user._id, members: [nameLead.user._id, nameMate.user._id] });
    var csv = [HEADER,
      csvRow(["Linked App", "https://demo-hack.devpost.com/submissions/111-linked-app", "Submitted (Gallery/Visible)", "[MLH] Best Use of Gemini API, Sponsor Prize", "Someone", "Else", "not-registered@example.com", "[DEMO] [SOFTWARE] Best Beginner Hack", "No", "", "", ""]),
      csvRow(["Email App", "https://demo-hack.devpost.com/submissions/222-email-app", "Submitted (Gallery/Visible)", "Sponsor Prize", "Email", "Lead", "EMAIL@example.com", "[DEMO] [HARDWARE] Best Hardware Hack", "Yes", "", "", ""]),
      csvRow(["Twin App", "https://demo-hack.devpost.com/submissions/444-twin-app", "Submitted (Gallery/Visible)", "", "Nobody", "Known", "nobody@example.com", "", "", "", "", ""]),
      csvRow(["Name App", "https://demo-hack.devpost.com/submissions/333-name-app", "Submitted (Gallery/Visible)", "", "nina", "named", "other-address@example.com", "Best Design", "", "Sam", "Same", "twin-other@example.com"]),
    ].join("\n");
    var response = await upload(admin, csv);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    var preview = response.body.preview;
    assert.deepEqual(preview.counts, { new: 4, updated: 0, unchanged: 0, errors: 0 });
    assert.deepEqual(preview.unrecognizedColumns, ["Project Status"]);
    var byName = Object.fromEntries(preview.rows.map(function row(r) { return [r.project.name, r]; }));
    var linked = byName["Linked App"];
    assert.equal(linked.project.devpostUrl, "https://devpost.com/software/linked-app");
    assert.equal(String(linked.matchedTeam.id), String(linkTeam._id));
    assert.deepEqual(linked.project.mlhTracks, ["[MLH] Best Use of Gemini API"]);
    assert.equal(linked.project.category, "[DEMO] [SOFTWARE] Best Beginner Hack");
    assert.equal(linked.project.hardware, false);
    assert.equal(byName["Twin App"].matchedTeam, null, "two suffixed teams fit: never guess");
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

  await t.test("admins become judges from the judges tab without losing their role or getting an invite", async function () {
    var EmailLog = require("../schemas/emailLog");
    var boss = await fixtures.createUser({ role: "admin", name: "Boss Admin", email: "boss@example.com" });
    var mod = await fixtures.createUser({ role: "moderator", email: "mod@example.com" });
    var before = await EmailLog.countDocuments({});
    await post(admin, "/api/admin/judges", { name: "Boss Admin", email: "BOSS@example.com", hardware: true }).expect(201);
    assert.equal((await User.findById(boss.user._id)).role, "admin");
    var profile = await Profile.findOne({ user: boss.user._id });
    assert.equal(profile.active, true);
    assert.equal(profile.hardware, true);
    assert.equal(await EmailLog.countDocuments({}), before, "no invite email for an admin");
    await post(admin, "/api/admin/judges", { name: "Mod", email: "mod@example.com", hardware: false }).expect(409);
    assert.equal((await User.findById(mod.user._id)).role, "moderator");
    var list = (await request(app).get("/api/admin/judges").set(auth(admin)).expect(200)).body.judges;
    var listed = list.find(function same(j) { return j._id === boss.user.id; });
    assert.ok(listed, "admin judge is listed");
    assert.equal(listed.inviteStatus, "accepted");
    await request(app).patch("/api/admin/judges/" + boss.user.id).set(auth(admin)).send({ hardware: false }).expect(200);
    await request(app).patch("/api/admin/judges/" + boss.user.id).set(auth(admin)).send({ name: "Renamed" }).expect(400);
    await request(app).delete("/api/admin/judges/" + boss.user.id).set(auth(admin)).expect(200);
    assert.equal((await User.findById(boss.user._id)).role, "admin");
    assert.equal((await Profile.findOne({ user: boss.user._id })).active, false);
    list = (await request(app).get("/api/admin/judges").set(auth(admin)).expect(200)).body.judges;
    assert.ok(!list.some(function same(j) { return j._id === boss.user.id; }));
    await Profile.deleteMany({});
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
    // Fewer judges than requested: one judging per judge, with a warning, not a failure.
    var short = await post(admin, adminRoot + "/assignments", { judgingsPerProject: 3 }).expect(201);
    var regular = short.body.verifierReport.find(function pool(r) { return r.pool === "regular"; });
    assert.equal(regular.judgingsPerProject, 2);
    assert.match(regular.warnings[0], /Only 2 eligible judges .* 2 judgings instead of 3/);
    short.body.assignment.queues.forEach(function full(q) { assert.equal(q.projects.length, 4); });
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
  await t.test("rooms take table ranges: validation, overlaps, listing and desk assignment", async function () {
    var rooms = adminRoot + "/rooms";
    // Earlier subtests left an assignment version (and scores): rooms are locked.
    assert.ok(await Assignment.exists({}));
    var locked = await post(admin, rooms, { name: "X", order: 1, tableStart: 900, tableEnd: 901, hardware: false }).expect(409);
    assert.match(locked.body.error, /locked once judge assignments exist/);
    await post(admin, adminRoot + "/close").expect(200);
    var withScores = await request(app).delete(adminRoot + "/assignments").set(auth(admin)).expect(409);
    assert.match(withScores.body.error, /already scored/);
    await Score.deleteMany({});
    await post(admin, adminRoot + "/open").expect(200);
    var open = await request(app).delete(adminRoot + "/assignments").set(auth(admin)).expect(409);
    assert.match(open.body.error, /Close judging/);
    await post(admin, adminRoot + "/close").expect(200);
    var wiped = await request(app).delete(adminRoot + "/assignments").set(auth(admin)).expect(200);
    assert.ok(wiped.body.deleted >= 1);
    assert.equal(await Assignment.countDocuments({}), 0);
    assert.equal((await State.findById("judging").lean()).activeVersion, null);
    await Project.deleteMany({});
    await require("../schemas/judgingTable").deleteMany({});
    await Room.deleteMany({});
    await post(admin, rooms, { name: "Bad", order: 1, tableStart: 5, tableEnd: 1, hardware: false }).expect(400);
    await post(admin, rooms, { name: "Bad", order: 1, tableStart: 0, tableEnd: 3, hardware: false }).expect(400);
    await post(admin, rooms, { name: "Half", order: 1, tableStart: 3, hardware: false }).expect(400);
    var a = (await post(admin, rooms, { name: "Room A", order: 1, tableStart: 1, tableEnd: 5, hardware: false }).expect(201)).body.room;
    assert.equal(a.capacity, 5);
    var overlap = await post(admin, rooms, { name: "Room B", order: 2, tableStart: 5, tableEnd: 9, hardware: false }).expect(409);
    assert.match(overlap.body.error, /Table 5 is already in Room A/);
    var b = (await post(admin, rooms, { name: "Room B", order: 2, tableStart: 6, tableEnd: 9, hardware: false }).expect(201)).body.room;
    await post(admin, rooms, { name: "Lab", order: 3, tableStart: 100, tableEnd: 102, hardware: true }).expect(201);
    await request(app).patch(rooms + "/" + b._id).set(auth(admin)).send({ tableStart: 4, tableEnd: 9 }).expect(409);
    var edited = (await request(app).patch(rooms + "/" + b._id).set(auth(admin)).send({ tableStart: 6, tableEnd: 12 }).expect(200)).body.room;
    assert.equal(edited.capacity, 7);
    var listed = (await request(app).get(rooms).set(auth(admin)).expect(200)).body.rooms;
    assert.deepEqual(listed.map(function r(x) { return [x.name, x.tableStart, x.tableEnd]; }), [["Room A", 1, 5], ["Room B", 6, 12], ["Lab", 100, 102]]);
    var moderator = await fixtures.createUser({ role: "moderator" });
    async function arrive(hardware) {
      var person = await fixtures.createUser();
      await Application.create({ applicant: person.user._id, status: "accepted" });
      await Project.create({ name: "R" + person.user.id, devpostUrl: "https://devpost.com/software/r" + person.user.id, members: [person.user._id], hardware: hardware });
      return (await post(moderator, "/api/staff/judging/desk-checkin", { userId: person.user.id }).expect(200)).body.project;
    }
    assert.equal((await arrive(false)).tableNumber, 1);
    var hw = await arrive(true);
    assert.equal(hw.tableNumber, 100);
    assert.equal(hw.room.name, "Lab");
    assert.equal((await arrive(false)).tableNumber, 2);
    // Rooms stay editable during check-ins as long as no assigned table moves.
    var late = (await post(admin, rooms, { name: "Late", order: 4, tableStart: 200, tableEnd: 201, hardware: false }).expect(201)).body.room;
    await post(admin, rooms, { name: "Rangeless", order: 5, capacity: 3, hardware: false }).expect(409);
    var lab = listed.find(function same(r) { return r.name === "Lab"; });
    var grown = (await request(app).patch(rooms + "/" + lab._id).set(auth(admin)).send({ tableStart: 100, tableEnd: 110 }).expect(200)).body.room;
    assert.equal(grown.capacity, 11);
    var shrink = await request(app).patch(rooms + "/" + a._id).set(auth(admin)).send({ tableStart: 2, tableEnd: 5 }).expect(409);
    assert.match(shrink.body.error, /Table 1 already belongs to/);
    var flip = await request(app).patch(rooms + "/" + lab._id).set(auth(admin)).send({ hardware: false }).expect(409);
    assert.match(flip.body.error, /can't switch between hardware and software/);
    await request(app).patch(rooms + "/" + b._id).set(auth(admin)).send({ order: 9 }).expect(200);
    await request(app).delete(rooms + "/" + a._id).set(auth(admin)).expect(409);
    await request(app).delete(rooms + "/" + late._id).set(auth(admin)).expect(200);
    // New tables are used by the next arrivals, and earlier tables never move.
    assert.equal((await arrive(false)).tableNumber, 3);
    assert.equal((await Project.findOne({ tableNumber: 100 })).hardware, true);
  });
});
