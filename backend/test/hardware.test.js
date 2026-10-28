"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var mongoose = require("mongoose");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var routes = require("./helpers/routes");
var Item = require("../schemas/hardwareItem");
var Checkout = require("../schemas/hardwareCheckout");
var Application = require("../schemas/application");
var User = require("../schemas/user");
var OrgSettings = require("../schemas/orgSettings");
var settingsCache = require("../utils/orgSettingsCache");
var mailer = require("../utils/mailer");
var Team = require("../schemas/team");
var EmailLog = require("../schemas/emailLog");
var EmailTemplate = require("../schemas/emailTemplate");
var mailMock = require("./helpers/mailMock");
var realSendTemplateEmail = mailer.sendTemplateEmail;
var parseCsv = require("csv-parse/sync").parse;

function auth(person) { return { Authorization: "Bearer " + person.token }; }
async function seed() {
  await db.clearDatabase();
  settingsCache.clear();
  var p = {};
  p.admin = await fixtures.createUser({ role: "admin" });
  p.mod = await fixtures.createUser({ role: "moderator" });
  p.attendee = await fixtures.createUser({ name: "Borrower", checkedIn: true });
  p.other = await fixtures.createUser({ name: "Private borrower", checkedIn: true });
  // Issue their check-in codes, as acceptance does (fixtures don't have one).
  p.attendee.user.qrId = await User.ensureQrId(p.attendee.user._id);
  p.other.user.qrId = await User.ensureQrId(p.other.user._id);
  for (var person of [p.attendee, p.other]) await Application.create({ applicant: person.user._id, name: person.user.name, status: "accepted" });
  p.item = await Item.create({ name: "Board", totalQty: 3, availableQty: 3, maxPerAttendee: 10 });
  return p;
}
function checkout(p, person, fields) {
  return request(app).post("/api/staff/hardware/checkouts").set(auth(p.mod)).send(Object.assign({ userId: person.user.id, itemId: p.item.id }, fields));
}

async function waitFor(predicate) {
  for (var attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise(function pause(resolve) { setTimeout(resolve, 20); });
  }
  assert.fail("Background notification did not finish");
}

test("hardware lab", async function hardware(t) {
  await db.connect();
  t.after(db.closeDatabase);
  t.mock.method(mailer, "sendTemplateEmail", function noMail() { return Promise.resolve(); });

  await t.test("team snapshot, current team, CSV and event deadline", async function () {
    var p = await seed();
    var team = await Team.create({ name: "Original team", nameKey: "original team", leader: p.other.user._id, members: [p.attendee.user._id, p.other.user._id] });
    var deadline = new Date(Date.now() + 86400000).toISOString();
    await OrgSettings.create({ key: "default", hardwareReturnBy: deadline });
    var created = await checkout(p, p.attendee);
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.checkout.team, { id: team.id, name: team.name });
    assert.equal(created.body.checkout.dueAt, deadline);
    var url = "/api/staff/hardware/checkouts?userId=" + p.attendee.user.id;
    var before = (await request(app).get(url).set(auth(p.mod)).expect(200)).body;
    assert.deepEqual(before.attendee.team, { id: team.id, name: team.name });
    assert.equal(before.checkouts[0].teamChanged, false);
    await request(app).post("/api/teams/me/leave").set(auth(p.attendee)).expect(200);
    var after = (await request(app).get(url).set(auth(p.mod)).expect(200)).body;
    assert.equal(after.attendee.team, null);
    assert.equal(after.checkouts[0].currentTeam, null);
    assert.equal(after.checkouts[0].teamChanged, true);
    assert.equal(after.checkouts[0].team.name, team.name);
    await waitFor(async function notified() { return Boolean((await Checkout.findById(created.body.checkout._id)).teamChangeNotifiedAt); });
    var history = await request(app).get("/api/staff/hardware/export.csv").set(auth(p.mod)).expect(200);
    var rows = parseCsv(history.text, { columns: true, bom: true });
    assert.equal(rows[0].team, team.name);
    assert.deepEqual(Object.keys(rows[0]).slice(0, 4), ["item", "name", "email", "team"]);
    var explicit = new Date(Date.now() + 172800000).toISOString();
    assert.equal((await checkout(p, p.other, { dueAt: explicit })).body.checkout.dueAt, explicit);
    await OrgSettings.updateOne({}, { $set: { hardwareReturnBy: new Date(Date.now() - 1000) } });
    assert.equal((await checkout(p, p.other)).body.checkout.dueAt, null);
  });
  await t.test("membership changes queue one email per open loan, addressed to the borrower", async function (sub) {
    var p = await seed();
    sub.mock.method(mailer, "sendTemplateEmail", realSendTemplateEmail);
    mailMock.mockTransport(sub);
    await EmailTemplate.seedDefaults();
    var team = await Team.create({ name: "First team", nameKey: "first team", leader: p.other.user._id, members: [p.other.user._id, p.attendee.user._id] });
    var open = (await checkout(p, p.attendee)).body.checkout;
    var returned = (await checkout(p, p.attendee)).body.checkout;
    await request(app).post("/api/staff/hardware/checkouts/" + returned._id + "/return").set(auth(p.mod)).expect(200);
    await request(app).post("/api/teams/me/leave").set(auth(p.attendee)).expect(200);
    await waitFor(async function logged() { return await EmailLog.countDocuments({ templateKey: "hardware_team_change", status: "sent" }) === 1; });
    var log = await EmailLog.findOne({ templateKey: "hardware_team_change" });
    assert.equal(log.to, p.attendee.user.email);
    assert.equal(log.values.items, "- Board (checked out with First team)");
    assert.equal(log.values.returnBy, "the last day of the event");
    assert.ok((await Checkout.findById(open._id)).teamChangeNotifiedAt);
    assert.equal((await Checkout.findById(returned._id)).teamChangeNotifiedAt, null);
    await request(app).post("/api/teams").set(auth(p.attendee)).send({ name: "Next team" }).expect(201);
    await request(app).post("/api/teams/me/leave").set(auth(p.other)).expect(200);
    await new Promise(function settle(resolve) { setTimeout(resolve, 100); });
    assert.equal(await EmailLog.countDocuments({ templateKey: "hardware_team_change" }), 1);
    // Finish receipt work before the next test clears the database.
    await waitFor(async function receiptsDone() { return await EmailLog.countDocuments({ templateKey: { $in: ["hardware_checkout", "hardware_return"] }, status: "sent" }) === 3; });
    assert.equal(await Team.countDocuments({ _id: team._id }), 0);
  });
  await t.test("leader removal notifies the removed member; joining from no team also counts", async function (sub) {
    var p = await seed();
    sub.mock.method(mailer, "sendTemplateEmail", realSendTemplateEmail);
    mailMock.mockTransport(sub);
    await EmailTemplate.seedDefaults();
    await Team.create({ name: "Members", nameKey: "members", leader: p.other.user._id, members: [p.other.user._id, p.attendee.user._id] });
    await checkout(p, p.attendee);
    await request(app).delete("/api/teams/me/members/" + p.attendee.user.id).set(auth(p.other)).expect(200);
    await waitFor(async function logged() { return await EmailLog.countDocuments({ templateKey: "hardware_team_change", status: "sent" }) === 1; });
    assert.equal((await EmailLog.findOne({ templateKey: "hardware_team_change" })).to, p.attendee.user.email);
    await checkout(p, p.attendee);
    await request(app).post("/api/teams/me/invites").set(auth(p.other)).send({ email: p.attendee.user.email }).expect(201);
    var team = await Team.findOne({ members: p.other.user._id });
    await request(app).post("/api/teams/invites/" + team.id + "/accept").set(auth(p.attendee)).expect(200);
    await waitFor(async function loggedAgain() { return await EmailLog.countDocuments({ templateKey: "hardware_team_change", status: "sent" }) === 2; });
    var logs = await EmailLog.find({ templateKey: "hardware_team_change" }).sort({ createdAt: 1 });
    assert.equal(logs[1].values.items, "- Board (checked out with no team)");
    assert.equal(logs[1].values.newTeam, "Members");
    await waitFor(async function inviteDone() { return await EmailLog.countDocuments({ templateKey: "team_invite", status: "sent" }) === 1; });
    await waitFor(async function receiptsDone() { return await EmailLog.countDocuments({ templateKey: "hardware_checkout", status: "sent" }) === 2; });
  });
  await t.test("no loans or a disabled hardware module sends no team-change notice", async function (sub) {
    var p = await seed();
    sub.mock.method(mailer, "sendTemplateEmail", realSendTemplateEmail);
    mailMock.mockTransport(sub);
    await EmailTemplate.seedDefaults();
    await request(app).post("/api/teams").set(auth(p.attendee)).send({ name: "Empty hands" }).expect(201);
    await request(app).post("/api/teams/me/leave").set(auth(p.attendee)).expect(200);
    await new Promise(function settle(resolve) { setTimeout(resolve, 100); });
    await checkout(p, p.attendee);
    // Checkout already created the settings row (it reads hardwareReturnBy).
    await OrgSettings.updateOne({ key: "default" }, { $set: { "features.hardware": false } }, { upsert: true });
    settingsCache.clear();
    await request(app).post("/api/teams").set(auth(p.attendee)).send({ name: "Module off" }).expect(201);
    await new Promise(function settle(resolve) { setTimeout(resolve, 100); });
    assert.equal(await EmailLog.countDocuments({ templateKey: "hardware_team_change" }), 0);
    await waitFor(async function receiptDone() { return await EmailLog.countDocuments({ templateKey: "hardware_checkout", status: "sent" }) === 1; });
    assert.equal((await Checkout.findOne({ user: p.attendee.user._id })).teamChangeNotifiedAt, null);
  });
  await t.test("permissions and disabled feature on every hardware route", async function () {
    var p = await seed();
    var hardwareRoutes = routes.listRoutes(app).filter(function hardwareRoute(route) { return /\/hardware(?:\/|$)/.test(route.path) && route.path.indexOf("/meta/") === -1; });
    for (var route of hardwareRoutes) {
      var path = route.path.replace(":id", new mongoose.Types.ObjectId().toString());
      assert.equal((await request(app)[route.method.toLowerCase()](path)).status, 401, route.path);
      var isStaff = route.path.includes("/staff/");
      var isAdmin = route.path.includes("/admin/");
      for (var role of ["attendee", "mod", "admin"]) {
        var response = await request(app)[route.method.toLowerCase()](path).set(auth(p[role])).send({});
        if ((isStaff && role === "attendee") || (isAdmin && role !== "admin")) assert.equal(response.status, 403, route.path);
        else assert.ok(![401, 403, 500].includes(response.status), route.path + ": " + response.status);
      }
    }
    await OrgSettings.create({ key: "default", features: { hardware: false } });
    settingsCache.clear();
    for (var route of hardwareRoutes) {
      for (var person of [null, p.attendee, p.mod, p.admin]) {
        var req = request(app)[route.method.toLowerCase()](route.path.replace(":id", p.item.id));
        if (person) req.set(auth(person));
        assert.equal((await req.send({})).status, 404, route.path);
      }
    }
  });
  await t.test("ten concurrent checkouts claim exactly three units", async function () {
    var p = await seed();
    var responses = await Promise.all(Array.from({ length: 10 }, function attempt() { return checkout(p, p.attendee); }));
    assert.equal(responses.filter(function ok(res) { return res.status === 201; }).length, 3);
    assert.equal((await Item.findById(p.item.id)).availableQty, 0);
    assert.equal(await Checkout.countDocuments({ returnedAt: null }), 3);
  });
  await t.test("attendee limit holds under concurrency and counts only open loans", async function () {
    var p = await seed();
    await Item.updateOne({ _id: p.item.id }, { $set: { maxPerAttendee: 1, totalQty: 20, availableQty: 20 } });
    var results = await Promise.all(Array.from({ length: 10 }, function attempt() { return checkout(p, p.attendee); }));
    assert.equal(results.filter(function ok(res) { return res.status === 201; }).length, 1);
    assert.equal((await Item.findById(p.item.id)).availableQty, 19);
    var loan = await Checkout.findOne({});
    await request(app).post("/api/staff/hardware/checkouts/" + loan.id + "/return").set(auth(p.mod)).expect(200);
    assert.equal((await checkout(p, p.attendee)).status, 201);
  });
  await t.test("must be accepted AND checked in; QR resolution reused", async function () {
    var p = await seed();
    await Application.updateOne({ applicant: p.attendee.user._id }, { $set: { status: "rejected" } });
    assert.equal((await checkout(p, p.attendee)).status, 400);
    await Application.updateOne({ applicant: p.attendee.user._id }, { $set: { status: "accepted" } });
    var User = require("../schemas/user");
    await User.updateOne({ _id: p.attendee.user._id }, { $set: { checkedIn: false } });
    assert.equal((await checkout(p, p.attendee)).status, 400);
    await User.updateOne({ _id: p.attendee.user._id }, { $set: { checkedIn: true } });
    var res = await request(app).post("/api/staff/hardware/checkouts").set(auth(p.mod)).send({ qrId: p.attendee.user.qrId, itemId: p.item.id });
    assert.equal(res.status, 201);
  });
  await t.test("parallel double return is a no-op and retains history", async function () {
    var p = await seed();
    var loan = (await checkout(p, p.attendee)).body.checkout;
    var responses = await Promise.all([1, 2].map(function ret() { return request(app).post("/api/staff/hardware/checkouts/" + loan._id + "/return").set(auth(p.mod)); }));
    assert.deepEqual(responses.map(function status(res) { return res.status; }), [200, 200]);
    assert.equal(responses.filter(function changed(res) { return !res.body.alreadyReturned; }).length, 1);
    assert.equal((await Item.findById(p.item.id)).availableQty, 3);
    assert.equal(await Checkout.countDocuments({}), 1);
    assert.ok((await Checkout.findById(loan._id)).returnedAt);
    await request(app).delete("/api/admin/hardware/items/" + p.item.id).set(auth(p.admin)).expect(200);
    assert.equal((await Checkout.findById(loan._id).populate("item")).item.name, "Board");
  });
  await t.test("failed checkout restores stock and responds", async function (sub) {
    var p = await seed();
    sub.mock.method(Checkout, "create", function fail() { return Promise.reject(new Error("Simulated save failure")); });
    assert.equal((await checkout(p, p.attendee)).status, 500);
    assert.equal((await Item.findById(p.item.id)).availableQty, 3);
    assert.equal(await Checkout.countDocuments({}), 0);
  });
  await t.test("attendee catalog and own history never disclose other borrowers", async function () {
    var p = await seed();
    await checkout(p, p.other);
    await checkout(p, p.attendee);
    for (var path of ["/api/hardware", "/api/hardware/mine"]) {
      var res = await request(app).get(path).set(auth(p.attendee)).expect(200);
      assert.ok(!res.text.includes(p.other.user.name));
      assert.ok(!res.text.includes(p.other.user.email));
      assert.ok(!res.text.includes(p.other.user.qrId));
      assert.ok(!res.text.includes("passwordHash"));
    }
    var mine = await request(app).get("/api/hardware/mine").set(auth(p.attendee));
    assert.equal(mine.body.checkouts.length, 1);
    var filtered = await request(app).get("/api/hardware?q=missing&category=missing").set(auth(p.attendee));
    assert.equal(filtered.body.items.length, 0);
  });
  await t.test("CSV preview validates all rows; import and safe exports", async function () {
    var p = await seed();
    var text = 'name,category,totalQty,maxPerAttendee\n"Sensor, board",Sensors,4,2\n=Formula,Sensors,2,1\n';
    var preview = await request(app).post("/api/admin/hardware/import").set(auth(p.admin)).send({ csv: text }).expect(200);
    assert.equal(preview.body.items.length, 2);
    assert.equal(await Item.countDocuments({}), 1);
    await request(app).post("/api/admin/hardware/import").set(auth(p.admin)).send({ csv: "name,totalQty\nGood,2\nBad,-1", preview: false }).expect(400);
    assert.equal(await Item.countDocuments({}), 1);
    await request(app).post("/api/admin/hardware/import").set(auth(p.admin)).send({ csv: text, preview: false }).expect(201);
    var exported = await request(app).get("/api/staff/hardware/export.csv?kind=inventory").set(auth(p.mod)).expect(200);
    var rows = parseCsv(exported.text, { columns: true, bom: true });
    assert.equal(rows.length, 3);
    assert.ok(rows.some(function quoted(row) { return row.name === "Sensor, board"; }));
    assert.ok(rows.some(function safe(row) { return row.name === "'=Formula"; }));
    await checkout(p, p.attendee, { notes: "=danger" });
    var history = await request(app).get("/api/staff/hardware/export.csv").set(auth(p.mod)).expect(200);
    assert.equal(parseCsv(history.text, { columns: true, bom: true })[0].notes, "'=danger");
  });
  await t.test("inventory edits preserve loans and staff filters find their borrowers", async function () {
    var p = await seed();
    var due = new Date(Date.now() + 86400000).toISOString();
    var loan = (await checkout(p, p.attendee, { dueAt: due })).body.checkout;
    await request(app).patch("/api/admin/hardware/items/" + p.item.id).set(auth(p.admin)).send({ totalQty: 0 }).expect(400);
    await request(app).delete("/api/admin/hardware/items/" + p.item.id).set(auth(p.admin)).expect(409);
    await request(app).patch("/api/admin/hardware/items/" + p.item.id).set(auth(p.admin)).send({ totalQty: 5 }).expect(200);
    assert.equal((await Item.findById(p.item.id)).availableQty, 4);
    var byItem = await request(app).get("/api/staff/hardware/checkouts?open=1&itemId=" + p.item.id).set(auth(p.mod)).expect(200);
    assert.equal(byItem.body.checkouts[0].user.email, p.attendee.user.email);
    assert.ok(!byItem.text.includes("qrId"));
    var byQr = await request(app).get("/api/staff/hardware/checkouts?open=1&qrId=" + p.attendee.user.qrId).set(auth(p.mod)).expect(200);
    assert.equal(byQr.body.attendee.id, p.attendee.user.id);
    assert.equal(byQr.body.checkouts.length, 1);
    await Checkout.updateOne({ _id: loan._id }, { $set: { dueAt: new Date(Date.now() - 1000) } });
    var overdue = await request(app).get("/api/staff/hardware/checkouts?overdue=1").set(auth(p.mod)).expect(200);
    assert.equal(overdue.body.checkouts.length, 1);
    await Application.updateOne({ applicant: p.attendee.user._id }, { $set: { status: "rejected" } });
    await request(app).get("/api/hardware").set(auth(p.attendee)).expect(400);
    await request(app).get("/api/hardware/mine").set(auth(p.attendee)).expect(400);
  });
  await t.test("facility CRUD and printable QR labels", async function () {
    var p = await seed();
    var facility = (await request(app).post("/api/admin/hardware/facilities").set(auth(p.admin)).send({ name: "Makerspace", location: "Room 2", accessNotes: "Ask staff" }).expect(201)).body.facility;
    await request(app).patch("/api/admin/hardware/facilities/" + facility._id).set(auth(p.admin)).send({ accessNotes: "Training required" }).expect(200);
    var catalog = await request(app).get("/api/hardware").set(auth(p.attendee)).expect(200);
    assert.equal(catalog.body.facilities[0].accessNotes, "Training required");
    var labels = await request(app).get("/api/admin/hardware/labels").set(auth(p.admin)).expect(200);
    assert.match(labels.body.labels[0].qr, /^data:image\/png;base64,/);
    await request(app).delete("/api/admin/hardware/facilities/" + facility._id).set(auth(p.admin)).expect(200);
  });
  await t.test("mail is never awaited and deadlines use event time", async function (sub) {
    var p = await seed();
    var calls = [];
    sub.mock.method(mailer, "sendTemplateEmail", function pending(to, key, values) { calls.push({ to: to, key: key, values: values }); return new Promise(function never() {}); });
    var res = await checkout(p, p.attendee, { dueAt: new Date(Date.now() + 86400000).toISOString() });
    assert.equal(res.status, 201);
    await waitFor(function emailStarted() { return calls.length > 0; });
    assert.equal(calls[0].key, "hardware_checkout");
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(calls[0].values.dueTime));
    await request(app).post("/api/staff/hardware/checkouts/" + res.body.checkout._id + "/return").set(auth(p.mod)).expect(200);
    await checkout(p, p.other);
    await request(app).post("/api/staff/hardware/reminders").set(auth(p.mod)).send({ itemId: p.item.id }).expect(202);
    await waitFor(function reminderStarted() { return calls.some(function reminder(call) { return call.key === "hardware_reminder"; }); });
    assert.ok(calls.some(function reminder(call) { return call.key === "hardware_reminder" && call.to === p.other.user.email; }));
  });
});
