"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var mongoose = require("mongoose");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Workshop = require("../schemas/workshop");
var Signup = require("../schemas/workshopSignup");
var Attendance = require("../schemas/workshopAttendance");
var Draw = require("../schemas/raffleDraw");
var Settings = require("../schemas/orgSettings");
var cache = require("../utils/orgSettingsCache");

/** @param {object} user @param {string} path @returns {object} Supertest request. */
function get(user, path) {
  return request(app).get(path).set("Authorization", "Bearer " + user.token);
}

test("staff workshop overview counts and private signup exports", async function overview(t) {
  await db.connect();
  t.after(async function close() { cache.clear(); await db.closeDatabase(); });
  await db.clearDatabase();
  await Settings.findOneAndUpdate({ key: "default" }, { $set: { "features.workshops": true } }, { upsert: true });
  cache.clear();
  var admin = await fixtures.createUser({ role: "admin" });
  var mod = await fixtures.createUser({ role: "moderator" });
  var first = await fixtures.createUser({ name: "=Formula", email: "formula@example.com" });
  var second = await fixtures.createUser({ name: "Other, person" });
  var judge = await fixtures.createUser({ role: "judge" });
  var base = "/api/admin/workshops";
  var data = { startsAt: new Date("2026-11-14T12:00:00Z"), endsAt: new Date("2026-11-14T13:00:00Z") };
  var one = await Workshop.create(Object.assign({}, data, { title: "First", signupCount: 7, organizers: [first.user._id] }));
  var two = await Workshop.create(Object.assign({}, data, { title: "Second" }));
  var empty = await Workshop.create(Object.assign({}, data, { title: "Empty" }));
  await Attendance.create([
    { workshop: one._id, user: first.user._id, method: "code" },
    { workshop: one._id, user: second.user._id, method: "staff" },
    { workshop: two._id, user: second.user._id, method: "code" },
  ]);
  await Draw.create([
    { workshop: one._id, drawnBy: mod.user._id, prize: "Book", count: 2, poolSize: 3, winners: [
      { user: first.user._id, claimed: true }, { user: second.user._id, noShow: true, claimed: true },
    ] },
    { workshop: one._id, drawnBy: mod.user._id, prize: "Replacement", count: 1, poolSize: 1, winners: [{ user: admin.user._id } ] },
    { workshop: two._id, drawnBy: mod.user._id, prize: "Kit", count: 1, poolSize: 1, winners: [{ user: second.user._id, claimed: true }] },
  ]);
  var signedUpAt = new Date("2026-11-01T12:00:00Z");
  await Signup.create([
    { workshop: one._id, user: first.user._id, createdAt: signedUpAt },
    { workshop: one._id, user: judge.user._id },
    { workshop: two._id, user: second.user._id },
  ]);
  await t.test("counts are isolated per workshop and use one aggregate per collection", async function counts(t) {
    var attendanceAggregate = t.mock.method(Attendance, "aggregate");
    var drawAggregate = t.mock.method(Draw, "aggregate");
    var response = await get(mod, base);
    assert.equal(response.status, 200);
    assert.equal(attendanceAggregate.mock.callCount(), 1);
    assert.equal(drawAggregate.mock.callCount(), 1);
    attendanceAggregate.mock.restore();
    drawAggregate.mock.restore();
    var rows = new Map(response.body.workshops.map(function row(item) { return [item._id, item]; }));
    function totals(id) {
      var item = rows.get(String(id));
      return [item.attendedCount, item.drawCount, item.winnerCount, item.claimedCount];
    }
    assert.deepEqual(totals(one._id), [2, 2, 2, 1]);
    assert.deepEqual(totals(two._id), [1, 1, 1, 1]);
    assert.deepEqual(totals(empty._id), [0, 0, 0, 0]);
    assert.equal(rows.get(String(one._id)).signupCount, 7);
    assert.equal(rows.get(String(one._id)).organizers[0].name, first.user.name);
  });
  await t.test("JSON exposes only safe signup fields with workshop-specific attendance", async function json() {
    var response = await get(mod, base + "/" + one._id + "/signups");
    assert.equal(response.status, 200);
    assert.equal(response.body.signups.length, 2);
    var person = response.body.signups.find(function match(row) { return row.email === first.user.email; });
    assert.deepEqual(person, { name: first.user.name, email: first.user.email, signedUpAt: signedUpAt.toISOString(), attended: true });
    assert.equal(response.body.signups.find(function match(row) { return row.email === judge.user.email; }).attended, false);
    response.body.signups.forEach(function safe(row) {
      assert.deepEqual(Object.keys(row).sort(), ["attended", "email", "name", "signedUpAt"]);
    });
    assert.deepEqual((await get(mod, base + "/" + empty._id + "/signups")).body, { signups: [] });
  });
  await t.test("CSV escapes formulas and includes attendance and ISO signup time", async function csv() {
    var response = await get(admin, base + "/" + one._id + "/signups.csv");
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /text\/csv/);
    assert.match(response.headers["content-disposition"], /attachment/);
    assert.ok(response.text.includes("Name,Email,Signed up at,Attended\r\n"));
    assert.ok(response.text.includes("'=Formula,formula@example.com," + signedUpAt.toISOString() + ",true\r\n"));
    assert.match(response.text, /,false\r\n/);
    assert.ok(!response.text.includes("qrId"));
    var other = await get(mod, base + "/" + two._id + "/signups.csv");
    assert.ok(other.text.includes('"Other, person"'));
    assert.ok(!other.text.includes("formula@example.com"));
  });
  await t.test("only staff may access the overview or signups, including assigned organizers", async function permissions() {
    for (var suffix of ["", "/" + one._id + "/signups", "/" + one._id + "/signups.csv"]) {
      assert.equal((await get(first, base + suffix)).status, 403);
      assert.equal((await get(judge, base + suffix)).status, 403);
      assert.equal((await get(mod, base + suffix)).status, 200);
      assert.equal((await get(admin, base + suffix)).status, 200);
      assert.equal((await request(app).get(base + suffix)).status, 401);
    }
    for (var id of ["bad-id", String(new mongoose.Types.ObjectId())]) {
      for (var extension of ["signups", "signups.csv"]) {
        assert.equal((await get(mod, base + "/" + id + "/" + extension)).status, 404);
      }
    }
  });
  await t.test("disabled workshops return 404 for JSON, CSV and overview", async function disabled() {
    await Settings.findOneAndUpdate({ key: "default" }, { $set: { "features.workshops": false } });
    cache.clear();
    for (var suffix of ["", "/" + one._id + "/signups", "/" + one._id + "/signups.csv"]) {
      assert.equal((await get(mod, base + suffix)).status, 404);
    }
  });
});
