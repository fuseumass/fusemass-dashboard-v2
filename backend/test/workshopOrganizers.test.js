"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var mongoose = require("mongoose");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var Workshop = require("../schemas/workshop");
var Attendance = require("../schemas/workshopAttendance");
var Application = require("../schemas/application");
var Round = require("../schemas/applicationRound");
var Settings = require("../schemas/orgSettings");
var cache = require("../utils/orgSettingsCache");
var mailer = require("../utils/mailer");

/** @param {object} user @param {string} method @param {string} path @param {object} body @returns {object} Request. */
function call(user, method, path, body) {
  var req = request(app)[method](path).set("Authorization", "Bearer " + user.token);
  return body ? req.send(body) : req;
}

test("workshop organizer assignments, discovery and scoped controls", async function organizers(t) {
  await db.connect();
  t.after(async function close() { await db.closeDatabase(); });
  await db.clearDatabase();
  cache.clear();
  var sent = [];
  t.mock.method(mailer, "sendTemplateEmail", async function send(to, key, vars) {
    sent.push({ to: to, key: key, vars: vars });
  });
  var admin = await fixtures.createUser({ role: "admin" });
  var host = await fixtures.createUser({ name: "Workshop host" });
  var other = await fixtures.createUser();
  var mod = await fixtures.createUser({ role: "moderator" });
  var judge = await fixtures.createUser({ role: "judge" });
  var base = "/api/admin/workshops";
  var data = { title: "Build together", startsAt: "2026-10-24T12:00:00Z", endsAt: "2026-10-24T13:00:00Z", published: true, raffleEnabled: true };
  await t.test("staff email lookup returns only safe fields and rejects judges", async function () {
    var found = await call(admin, "get", base + "/organizer-lookup?email=" + encodeURIComponent(host.user.email.toUpperCase()));
    assert.equal(found.status, 200);
    assert.deepEqual(found.body.user, { id: String(host.user._id), name: host.user.name, email: host.user.email, role: "applicant" });
    var missing = await call(admin, "get", base + "/organizer-lookup?email=missing@example.com");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "No account with that email. Ask them to sign up first.");
    assert.equal((await call(admin, "get", base + "/organizer-lookup?email=" + judge.user.email)).status, 400);
    // Moderators manage workshops too; participants and judges can't look people up.
    for (var user of [host, judge]) assert.equal((await call(user, "get", base + "/organizer-lookup?email=" + host.user.email)).status, 403);
    assert.equal((await call(mod, "get", base + "/organizer-lookup?email=" + host.user.email)).status, 200);
  });
  var created = await call(admin, "post", base, Object.assign({}, data, { organizers: [String(host.user._id), String(host.user._id)] }));
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.workshop.organizers, [String(host.user._id)]);
  var id = created.body.workshop._id;
  await waitFor(function delivered() { return sent.length === 1; });
  assert.equal(sent[0].to, host.user.email);
  assert.equal(sent[0].key, "workshop_organizer_added");
  assert.equal(sent[0].vars.organizeUrl, require("../utils/clientOrigin").primaryClientOrigin() + "/dashboard/organize");
  await t.test("create and update validate organizer arrays", async function () {
    for (var input of [null, "invalid", ["invalid"], [new mongoose.Types.ObjectId().toString()], [String(judge.user._id)], Array(11).fill(String(host.user._id))]) {
      for (var method of ["post", "patch"]) {
        var res = await call(admin, method, base + (method === "patch" ? "/" + id : ""), Object.assign({}, data, { organizers: input }));
        assert.equal(res.status, 400, JSON.stringify(input));
      }
    }
  });
  await t.test("update deduplicates and only emails newly added people", async function () {
    var res = await call(admin, "patch", base + "/" + id, { organizers: [String(host.user._id), String(mod.user._id), String(mod.user._id)] });
    assert.equal(res.status, 200);
    assert.equal(res.body.workshop.organizers.length, 2);
    await waitFor(function delivered() { return sent.length === 2; });
    assert.equal(sent[1].to, mod.user.email);
    await call(admin, "patch", base + "/" + id, { title: "Updated" });
    await call(admin, "patch", base + "/" + id, { organizers: [String(host.user._id)] });
    // A newly added organizer send is the only background task, and both have finished.
    assert.equal(sent.length, 2);
  });
  await t.test("admin list populates organizers and attendee list strips them", async function () {
    var list = await call(admin, "get", base);
    assert.deepEqual(list.body.workshops[0].organizers[0], { _id: String(host.user._id), name: host.user.name, email: host.user.email });
    var round = await Round.create({ name: "General" });
    await Application.create({ applicant: other.user._id, round: round._id, name: "Attendee", status: "accepted" });
    var attendee = await call(other, "get", "/api/workshops");
    assert.equal(attendee.status, 200);
    assert.equal("organizers" in attendee.body.workshops[0], false);
  });
  await t.test("assigned applicant discovers and runs only their workshop", async function () {
    assert.equal((await call(host, "get", "/api/auth/me")).body.user.organizesWorkshops, true);
    assert.equal((await call(other, "get", "/api/auth/me")).body.user.organizesWorkshops, false);
    assert.equal((await call(judge, "get", "/api/auth/me")).body.user.organizesWorkshops, false);
    var mine = await call(host, "get", "/api/workshops/manageable");
    assert.equal(mine.body.workshops.length, 1);
    var attendance = await call(host, "get", "/api/workshops/" + id + "/attendance");
    assert.equal(attendance.status, 200);
    assert.equal(attendance.body.workshop.organizers[0].name, host.user.name);
    var foreign = await Workshop.create(data);
    for (var workshopId of [id, String(foreign._id)]) {
      var expected = workshopId === id ? 200 : 403;
      assert.equal((await call(host, "post", "/api/workshops/" + workshopId + "/attendance/open", { minutes: 10 })).status, expected);
      if (workshopId === id) {
        await require("../schemas/user").updateOne({ _id: other.user._id }, { checkedIn: true });
        await Attendance.create({ workshop: id, user: other.user._id, method: "staff", addedBy: host.user._id });
      }
      assert.equal((await call(host, "post", "/api/workshops/" + workshopId + "/raffle/draw", { count: 1, prize: "Book", early: true })).status, workshopId === id ? 201 : 403);
    }
    await Workshop.updateOne({ _id: id }, { cancelled: true });
    assert.equal((await call(host, "get", "/api/auth/me")).body.user.organizesWorkshops, false);
    await Workshop.updateOne({ _id: id }, { cancelled: false });
    await Settings.findOneAndUpdate({ key: "default" }, { $set: { "features.workshops": false } }, { upsert: true });
    cache.clear();
    var exists = t.mock.method(Workshop, "exists", function unexpected() { throw new Error("Disabled module must not query workshops"); });
    assert.equal((await call(host, "get", "/api/auth/me")).body.user.organizesWorkshops, false);
    exists.mock.restore();
  });
  await t.test("moderators create, edit and delete workshops and set organizers later", async function () {
    await Settings.findOneAndUpdate({ key: "default" }, { $set: { "features.workshops": true } }, { upsert: true });
    cache.clear();
    var helper = await fixtures.createUser();
    var created = await call(mod, "post", base, Object.assign({}, data, { title: "Mod run" }));
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.workshop.organizers, []);
    var edited = await call(mod, "patch", base + "/" + created.body.workshop._id, { organizers: [String(helper.user._id)] });
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.body.workshop.organizers.map(String), [String(helper.user._id)]);
    assert.equal((await call(mod, "delete", base + "/" + created.body.workshop._id)).status, 200);
  });
});
