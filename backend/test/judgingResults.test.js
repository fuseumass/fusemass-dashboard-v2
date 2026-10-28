"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var computeResults = require("../utils/judging/results").computeResults;
var rubric = [{ key: "a", weight: 2, kind: "general" }, { key: "b", weight: 1, kind: "general" }, { key: "c", weight: 3, kind: "category" }];

test("results: hand calculation, strict/generous reversal, averages, ties and flags", function () {
  var projects = ["A", "B", "C", "D", "E", "F"].map(function project(id) { return { _id: id, name: id, category: id === "F" ? "Other" : "Track", withdrawn: id === "E" }; });
  var scores = [
    { project: "A", judge: "strict", scores: { a: 3, b: 2, c: 2 } }, // G=8, adjusted=8+1*3=11; C=6, adjusted=6+1*3=9
    { project: "B", judge: "generous", scores: { a: 4, b: 2, c: 3 } }, // G=10, adjusted=10-3=7; C=9, adjusted=6
    { project: "C", judge: "strict", scores: new Map([["a", 3], ["b", 2], ["c", 2]]) },
    { project: "C", judge: "unknown", scores: { a: 6, b: 0, c: 4 } }, // mean raw=10, adjusted=(11+12)/2=11.5; category raw=9, adjusted=(9+12)/2=10.5
    { project: "E", judge: "strict", scores: { a: 10, b: 10, c: 10 } },
    { project: "F", judge: "generous", scores: { a: 4, b: 2, c: 3 } },
  ];
  var before = JSON.stringify(projects);
  var rows = computeResults(projects, scores, rubric, // Bias is per criterion point; Wg = 2+1 = 3 and Wc = 3 scale it.
    { strict: { general: -1, category: -1 }, generous: { general: 1, category: 1 } }, 2);
  var by = Object.fromEntries(rows.map(function row(p) { return [p._id, p]; }));
  assert.equal(by.A.rawGeneral, 8); assert.equal(by.B.rawGeneral, 10);
  assert.equal(by.A.adjustedGeneral, 11); assert.equal(by.B.adjustedGeneral, 7);
  assert.equal(by.C.rawGeneral, 10); assert.equal(by.C.adjustedGeneral, 11.5);
  assert.equal(by.C.rawCategory, 9); assert.equal(by.C.adjustedCategory, 10.5);
  assert.equal(by.A.adjustedCategory, 9); assert.equal(by.B.adjustedCategory, 6);
  // Raw B (10) beats A (8); bias correction reverses it. B and F tie at 3.
  assert.equal(by.C.overallRank, 1); assert.equal(by.A.overallRank, 2); assert.equal(by.B.overallRank, 3); assert.equal(by.F.overallRank, 3);
  assert.equal(by.C.categoryRank, 1); assert.equal(by.A.categoryRank, 2); assert.equal(by.F.categoryRank, 1);
  assert.deepEqual(by.C.flags, { missingScores: false, noCalibration: true });
  assert.deepEqual(by.C.uncalibratedJudges, ["unknown"]);
  assert.deepEqual(by.A.flags, { missingScores: true, noCalibration: false });
  assert.equal(by.D.rawGeneral, null); assert.equal(by.D.overallRank, null);
  assert.equal(by.E.overallRank, null); assert.equal(by.E.categoryRank, null);
  assert.equal(JSON.stringify(projects), before);
  assert.deepEqual(computeResults([], [], rubric, {}, 3), []);
});

test("results: category ties share rank and null bias stays unadjusted", function () {
  var rows = computeResults(["a", "b", "c"].map(function project(id) { return { _id: id, category: "Track" }; }),
    ["a", "b", "c"].map(function score(id, i) { return { judge: "uncalibrated", project: id, scores: { a: 1, b: 1, c: i === 2 ? 1 : 2 } }; }),
    rubric, { uncalibrated: null }, 1);
  assert.deepEqual(rows.map(function rank(p) { return p.categoryRank; }), [1, 1, 3]);
  rows.forEach(function unchanged(p) {
    assert.equal(p.rawGeneral, p.adjustedGeneral);
    assert.equal(p.rawCategory, p.adjustedCategory);
    assert.equal(p.flags.noCalibration, true);
    assert.equal(p.flags.missingScores, false);
  });
});

test("judging reports API: active queues, retained scores, permissions and safe CSV", async function (t) {
  var request = require("supertest");
  var db = require("./helpers/db");
  var fixtures = require("./helpers/fixtures");
  var app = require("../server");
  var Project = require("../schemas/project");
  var Score = require("../schemas/judgingScore");
  var Assignment = require("../schemas/judgingAssignment");
  var State = require("../schemas/judgingState");
  var Settings = require("../schemas/judgingSettings");
  var OrgSettings = require("../schemas/orgSettings");
  var cache = require("../utils/orgSettingsCache");
  await db.connect(); t.after(db.closeDatabase); await db.clearDatabase();
  var admin = await fixtures.createUser({ role: "admin" });
  var moderator = await fixtures.createUser({ role: "moderator" });
  var judge = await fixtures.createUser({ role: "judge", name: "=Judge", email: "judge@example.com" });
  var applicant = await fixtures.createUser({ role: "applicant" });
  var a = await Project.create({ name: "=Project", devpostUrl: "https://devpost.com/software/results-a", category: "@Track", tableNumber: 1 });
  var b = await Project.create({ name: "Pending", devpostUrl: "https://devpost.com/software/results-b" });
  var withdrawn = await Project.create({ name: "Withdrawn", devpostUrl: "https://devpost.com/software/results-w", withdrawn: true });
  var settings = await Settings.getSingleton();
  var values = Object.fromEntries(settings.criteria.map(function value(c) { return [c.key, c.max]; }));
  await Score.create({ judge: judge.user._id, project: a._id, scores: values, comments: '+SUM(1,2)\n"Notes"' });
  // This retained score is outside the active queue: results keep it, progress does not count it.
  await Score.create({ judge: admin.user._id, project: b._id, scores: values });
  await Assignment.create({ version: 1, createdBy: admin.user._id, params: { judgingsPerProject: 2 }, queues: [{ judge: judge.user._id, projects: [b._id] }] });
  await Assignment.create({ version: 2, createdBy: admin.user._id, params: { judgingsPerProject: 2 }, queues: [{ judge: judge.user._id, projects: [a._id, b._id, withdrawn._id] }] });
  await State.create({ _id: "judging", activeVersion: 2 });
  function get(path, person) { var req = request(app).get("/api/admin/judging/" + path); return person ? req.set("Authorization", "Bearer " + person.token) : req; }
  var progress = (await get("progress", moderator).expect(200)).body;
  assert.equal(progress.activeVersion, 2);
  assert.equal(progress.projects.length, 2);
  assert.deepEqual(progress.judges.map(function counts(j) { return [j.done, j.total]; }), [[1, 2]]);
  assert.equal(progress.projects.find(function same(p) { return p._id === a.id; }).scoresIn, 1);
  assert.equal(progress.projects.find(function same(p) { return p._id === b.id; }).scoresIn, 0);
  assert.equal(progress.missingProjects.length, 2); // target catches underassignment too
  var result = (await get("results", admin).expect(200)).body.results;
  assert.equal(result.find(function same(p) { return p._id === b.id; }).scoreCount, 1);
  assert.equal(result.find(function same(p) { return p._id === a.id; }).flags.noCalibration, true);
  var paths = ["progress", "results", "progress.csv", "results.csv", "scores.csv"];
  for (var path of paths) {
    await get(path).expect(401);
    await get(path, judge).expect(403); await get(path, applicant).expect(403);
    await get(path, moderator).expect(path.startsWith("progress") ? 200 : 403);
    await get(path, admin).expect(200);
  }
  var scores = await get("scores.csv", admin).expect("Content-Type", /text\/csv/).expect(200);
  assert.ok(scores.text.includes("'=Judge"));
  assert.ok(scores.text.includes("'=Project"));
  assert.ok(scores.text.includes('"\'+SUM(1,2)\n""Notes"""'));
  assert.ok(scores.text.includes("judge@example.com"));
  assert.ok(scores.text.includes(settings.criteria[0].label));
  assert.ok(scores.text.includes(",10,10,5,10,5,10,"));
  assert.match(scores.text, /\d{4}-\d\d-\d\dT/);
  assert.equal(scores.headers["cache-control"], "no-store");
  var exported = await get("results.csv", admin).expect(200);
  assert.ok(exported.text.includes("'@Track"));
  assert.ok(exported.text.includes("Adjusted general"));
  var judges = await get("progress.csv", moderator).expect(200);
  assert.ok(judges.text.includes("'=Judge,judge@example.com,1,2,2"));
  assert.ok(!JSON.stringify(progress).includes("passwordHash"));
  await State.updateOne({ _id: "judging" }, { $set: { activeVersion: null } });
  assert.equal((await get("progress", moderator).expect(200)).body.judges.length, 0);
  await get("progress.csv", moderator).expect(200);
  await OrgSettings.updateOne({}, { $set: { "features.judging": false } }, { upsert: true });
  cache.clear();
  for (var disabled of paths) { await get(disabled, admin).expect(404); await get(disabled).expect(404); }
});
