"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var OrgSettings = require("../schemas/orgSettings");
var User = require("../schemas/user");

/**
 * Fresh database: built-in templates, a round, staff, and one accepted and
 * one pending applicant.
 * @param {object} [settings] - OrgSettings fields to start with.
 * @returns {Promise<object>}
 */
async function seed(settings) {
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
  if (settings) await OrgSettings.create(Object.assign({ key: "default" }, settings));
  var round = await ApplicationRound.create({ name: "General", isOpen: true });
  var moderator = await fixtures.createUser({ role: "moderator" });
  var admin = await fixtures.createUser({ role: "admin" });
  var accepted = await fixtures.createUser({ role: "applicant", email: "ada@example.com", name: "Ada L" });
  await Application.create({
    applicant: accepted.user._id,
    round: round._id,
    status: "accepted",
    name: "Ada Lovelace",
    pronouns: "she/her",
    tshirtSize: "M",
    allergies: "Peanuts",
  });
  var pending = await fixtures.createUser({ role: "applicant", email: "grace@example.com", passwordHash: undefined });
  await Application.create({ applicant: pending.user._id, round: round._id, status: "pending", name: "Grace Hopper" });
  return { moderator: moderator, admin: admin, accepted: accepted, pending: pending };
}

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

test("check-in popup and attendee help", async function (t) {
  await db.connect();

  // ---- Check-in popup ----------------------------------------------------------

  await t.test("a check-in returns the popup: name, pronouns, shirt size by default", async function (t2) {
    var s = await seed();
    mailMock.mockTransport(t2);
    var res = await request(app).post("/api/staff/checkin").set(as(s.moderator)).send({ userId: String(s.accepted.user._id) });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.popup, [
      { key: "name", label: "Name", value: "Ada Lovelace" },
      { key: "pronouns", label: "Pronouns", value: "she/her" },
      { key: "tshirtSize", label: "T-shirt size", value: "M" },
    ]);
  });

  await t.test("the popup follows the admin's fields and order, and can be switched off", async function (t2) {
    var s = await seed({ checkInPopupFields: ["tshirtSize", "allergies", "major"] });
    mailMock.mockTransport(t2);
    var res = await request(app).post("/api/staff/checkin").set(as(s.moderator)).send({ userId: String(s.accepted.user._id) });
    assert.deepEqual(
      res.body.popup.map(function (row) { return row.key + "=" + row.value; }),
      ["tshirtSize=M", "allergies=Peanuts", "major=—"]
    );

    var off = await seed({ checkInPopupEnabled: false });
    var res2 = await request(app).post("/api/staff/checkin").set(as(off.moderator)).send({ userId: String(off.accepted.user._id) });
    assert.equal(res2.status, 201);
    assert.equal(res2.body.popup, null);
  });

  await t.test("admins set the popup; unknown fields are refused; moderators can't", async function () {
    var s = await seed();
    var options = await request(app).get("/api/admin/settings").set(as(s.admin));
    assert.equal(options.body.checkInPopupFieldOptions.tshirtSize, "T-shirt size");
    assert.deepEqual(options.body.settings.checkInPopupFields, ["name", "pronouns", "tshirtSize"]);

    var ok = await request(app)
      .patch("/api/admin/settings")
      .set(as(s.admin))
      .send({ checkInPopupEnabled: true, checkInPopupFields: ["name", "allergies", "name"] });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.settings.checkInPopupFields, ["name", "allergies"], "deduplicated");

    var bad = await request(app).patch("/api/admin/settings").set(as(s.admin)).send({ checkInPopupFields: ["passwordHash"] });
    assert.equal(bad.status, 400);
    var mod = await request(app).patch("/api/admin/settings").set(as(s.moderator)).send({ checkInPopupFields: ["name"] });
    assert.equal(mod.status, 403);
  });

  // ---- Attendee help ----------------------------------------------------------------

  await t.test("look someone up by email (any case): status, check-in, account", async function () {
    var s = await seed();
    var res = await request(app).get("/api/staff/attendee?email=ADA@Example.com").set(as(s.moderator));
    assert.equal(res.status, 200);
    assert.equal(res.body.attendee.name, "Ada Lovelace");
    assert.equal(res.body.attendee.applicationStatus, "accepted");
    assert.equal(res.body.attendee.checkedIn, false);
    assert.equal(res.body.attendee.accountReady, true);

    var pending = await request(app).get("/api/staff/attendee?email=grace@example.com").set(as(s.moderator));
    assert.equal(pending.body.attendee.applicationStatus, "pending");
    assert.equal(pending.body.attendee.accountReady, false, "no password yet");

    assert.equal((await request(app).get("/api/staff/attendee?email=nobody@example.com").set(as(s.moderator))).status, 404);
    assert.equal((await request(app).get("/api/staff/attendee?email=").set(as(s.moderator))).status, 400);
    assert.equal((await request(app).get("/api/staff/attendee?email=ada@example.com").set(as(s.accepted))).status, 403);
    assert.equal((await request(app).get("/api/staff/attendee?email=ada@example.com")).status, 401);
  });

  await t.test("resend the QR code email to an accepted attendee, not to others", async function (t2) {
    var s = await seed();
    var mail = mailMock.mockTransport(t2);
    var res = await request(app).post("/api/staff/attendee/resend-qr").set(as(s.moderator)).send({ email: "ada@example.com" });
    assert.equal(res.status, 200);
    assert.equal(mail.calls.length, 1, "sent before responding");
    assert.equal(mail.calls[0].to, "ada@example.com");
    assert.equal(mail.calls[0].attachments[0].cid, "checkin-qrcode");

    var pending = await request(app).post("/api/staff/attendee/resend-qr").set(as(s.moderator)).send({ email: "grace@example.com" });
    assert.equal(pending.status, 400);
    assert.equal(mail.calls.length, 1);
  });

  await t.test("account link: setup link without a password, reset link with one", async function (t2) {
    var s = await seed();
    var mail = mailMock.mockTransport(t2);

    var setup = await request(app).post("/api/staff/attendee/send-account-link").set(as(s.admin)).send({ email: "grace@example.com" });
    assert.equal(setup.status, 200);
    assert.equal(setup.body.kind, "setup");
    assert.match(mail.calls[0].subject, /Set up your/);
    assert.match(mail.calls[0].text, /reset-password\?token=[0-9a-f]+&setup=1/);
    var grace = await User.findOne({ email: "grace@example.com" });
    var days = (grace.resetPasswordExpires.getTime() - Date.now()) / 86400000;
    assert.ok(days > 6.9, "setup link lasts 7 days");

    var reset = await request(app).post("/api/staff/attendee/send-account-link").set(as(s.moderator)).send({ email: "ada@example.com" });
    assert.equal(reset.body.kind, "reset");
    assert.match(mail.calls[1].subject, /Reset your/);
    assert.match(mail.calls[1].text, /reset-password\?token=[0-9a-f]+/);
  });

  await t.test("force check-in by email: look up, then check in with a reason", async function (t2) {
    var s = await seed();
    var mail = mailMock.mockTransport(t2);
    var found = await request(app).get("/api/staff/attendee?email=grace@example.com").set(as(s.moderator));
    var res = await request(app)
      .post("/api/staff/checkin")
      .set(as(s.moderator))
      .send({ userId: found.body.attendee.id, force: true, reason: "Walk-in approved by the organizers" });
    assert.equal(res.status, 201);
    assert.equal(res.body.forced, true);
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    var after = await request(app).get("/api/staff/attendee?email=grace@example.com").set(as(s.moderator));
    assert.equal(after.body.attendee.checkedIn, true);
  });

  await db.closeDatabase();
});
