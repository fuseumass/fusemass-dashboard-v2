"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var calendar = require("../utils/calendar");
var User = require("../schemas/user");
var EmailTemplate = require("../schemas/emailTemplate");
var ApplicationRound = require("../schemas/applicationRound");
var Application = require("../schemas/application");
var CheckIn = require("../schemas/checkin");
var ScheduleEvent = require("../schemas/scheduleEvent");

process.env.ORG_WEBSITE_URL = "https://hackathon.example.com";
process.env.ORG_DISCORD_URL = "https://discord.gg/test-invite";
process.env.EVENT_TIMEZONE = "America/New_York";

/**
 * Fresh DB + seeded templates + built unique indexes.
 * @returns {Promise<void>}
 */
function resetFixtures() {
  return db
    .clearDatabase()
    .then(function afterClear() {
      return Promise.all([User.init(), CheckIn.init()]);
    })
    .then(function afterIndexes() {
      return EmailTemplate.seedDefaults();
    });
}

/**
 * An accepted applicant with a check-in code.
 * @param {object} [overrides] - User fields.
 * @returns {Promise<{user: object, token: string, qrId: string}>}
 */
function createAcceptedAttendee(overrides) {
  return Promise.all([
    fixtures.createUser(Object.assign({ role: "applicant" }, overrides || {})),
    ApplicationRound.create({ name: "Round " + Math.random(), isOpen: true }),
  ]).then(function afterCreate(results) {
    var attendee = results[0];
    return Application.create({
      applicant: attendee.user._id,
      round: results[1]._id,
      name: attendee.user.name,
      status: "accepted",
    })
      .then(function afterApplication() {
        return User.ensureQrId(attendee.user._id);
      })
      .then(function afterQrId(qrId) {
        return Object.assign({ qrId: qrId }, attendee);
      });
  });
}

/**
 * A two-item run of show (stored out of order on purpose).
 * @returns {Promise<void>}
 */
function seedRunOfShow() {
  return ScheduleEvent.create([
    {
      title: "Closing ceremony",
      startsAt: new Date("2026-10-25T17:00:00Z"),
      endsAt: new Date("2026-10-25T18:00:00Z"),
      location: "Main hall",
    },
    {
      title: "Opening ceremony",
      startsAt: new Date("2026-10-24T14:00:00Z"),
      endsAt: new Date("2026-10-24T15:00:00Z"),
      location: "Main hall",
      description: "Welcome, sponsors; rules",
    },
  ]);
}

test("first check-in: flag + checked-in email", async function checkedIn(t) {
  await db.connect();

  await t.test("sets the user's checkedIn flag", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var attendee = await createAcceptedAttendee();
    var moderator = await fixtures.createUser({ role: "moderator" });

    var me = await request(app).get("/api/auth/me").set("Authorization", "Bearer " + attendee.token);
    assert.equal(me.body.user.checkedIn, false);

    var res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", "Bearer " + moderator.token)
      .send({ qrId: attendee.qrId });
    assert.equal(res.status, 201);

    var saved = await User.findById(attendee.user._id);
    assert.equal(saved.checkedIn, true);
    assert.ok(saved.checkedInAt instanceof Date);

    me = await request(app).get("/api/auth/me").set("Authorization", "Bearer " + attendee.token);
    assert.equal(me.body.user.checkedIn, true);
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
  });

  await t.test("emails Discord, website and the run of show as a calendar invite, once", async function (t2) {
    await resetFixtures();
    await seedRunOfShow();
    var mail = mailMock.mockTransport(t2);
    var attendee = await createAcceptedAttendee({ name: "Ada Lovelace" });
    var moderator = await fixtures.createUser({ role: "moderator" });
    var auth = "Bearer " + moderator.token;

    await request(app).post("/api/staff/checkin").set("Authorization", auth).send({ qrId: attendee.qrId });
    await waitFor(function () {
      return mail.calls.length >= 1;
    });

    var sent = mail.calls[0];
    assert.equal(sent.to, attendee.user.email);
    assert.match(sent.subject, /checked in/i);
    assert.match(sent.text, /Hi Ada Lovelace/);
    assert.match(sent.text, /https:\/\/discord\.gg\/test-invite/);
    assert.match(sent.text, /https:\/\/hackathon\.example\.com/);
    assert.match(sent.html, /<a href="https:\/\/discord\.gg\/test-invite">/);
    assert.match(sent.html, /<a href="https:\/\/hackathon\.example\.com">/);

    // Run of show in the body, in order, in the event's time zone.
    assert.match(sent.text, /Sat, Oct 24, 10:00 AM – 11:00 AM: Opening ceremony \(Main hall\)\nSun, Oct 25, 1:00 PM – 2:00 PM: Closing ceremony/);

    assert.equal(sent.icalEvent.method, "PUBLISH");
    assert.equal(sent.icalEvent.filename, "run-of-show.ics");
    var ics = sent.icalEvent.content;
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.match(ics, /DTSTART:20261024T140000Z/);
    assert.match(ics, /DESCRIPTION:Welcome\\, sponsors\\; rules/);
    assert.match(ics, /URL:https:\/\/hackathon\.example\.com/);

    // A repeat scan answers 409 and sends nothing.
    var again = await request(app).post("/api/staff/checkin").set("Authorization", auth).send({ qrId: attendee.qrId });
    assert.equal(again.status, 409);
    await new Promise(function (resolve) {
      setTimeout(resolve, 100);
    });
    assert.equal(mail.calls.length, 1);
  });

  await t.test("simultaneous scans send a single email", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var attendee = await createAcceptedAttendee();
    var moderator = await fixtures.createUser({ role: "moderator" });

    var scans = await Promise.all(
      [1, 2, 3].map(function scan() {
        return request(app)
          .post("/api/staff/checkin")
          .set("Authorization", "Bearer " + moderator.token)
          .send({ qrId: attendee.qrId });
      })
    );
    assert.deepEqual(
      scans
        .map(function (r) {
          return r.status;
        })
        .sort(),
      [201, 409, 409]
    );
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    await new Promise(function (resolve) {
      setTimeout(resolve, 100);
    });
    assert.equal(mail.calls.length, 1);
  });

  await t.test("without a run of show there is no invite and no empty heading", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var attendee = await createAcceptedAttendee();
    var moderator = await fixtures.createUser({ role: "moderator" });

    await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", "Bearer " + moderator.token)
      .send({ qrId: attendee.qrId });
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.equal(mail.calls[0].icalEvent, undefined);
    assert.doesNotMatch(mail.calls[0].text, /Run of show/);
  });

  await t.test("a repeat scan repairs a missing flag", async function (t2) {
    await resetFixtures();
    mailMock.mockTransport(t2);
    var attendee = await createAcceptedAttendee();
    var moderator = await fixtures.createUser({ role: "moderator" });
    await CheckIn.create({ user: attendee.user._id, checkedInBy: moderator.user._id });

    var res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", "Bearer " + moderator.token)
      .send({ qrId: attendee.qrId });
    assert.equal(res.status, 409);
    var saved = await User.findById(attendee.user._id);
    assert.equal(saved.checkedIn, true);
  });

  await t.test("stats count accepted attendees and arrivals", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var first = await createAcceptedAttendee();
    await createAcceptedAttendee();
    var moderator = await fixtures.createUser({ role: "moderator" });
    var auth = "Bearer " + moderator.token;

    await request(app).post("/api/staff/checkin").set("Authorization", auth).send({ qrId: first.qrId });
    var res = await request(app).get("/api/staff/checkin/stats").set("Authorization", auth);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { accepted: 2, checkedIn: 1, forced: 0 });

    res = await request(app).get("/api/staff/checkin/stats").set("Authorization", "Bearer " + first.token);
    assert.equal(res.status, 403);
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
  });
});

test("run of show admin CRUD", async function runOfShow(t) {
  await db.connect();
  await resetFixtures();
  var admin = await fixtures.createUser({ role: "admin" });
  var auth = "Bearer " + admin.token;

  await t.test("is admin-only", async function () {
    var moderator = await fixtures.createUser({ role: "moderator" });
    var res = await request(app).get("/api/admin/schedule").set("Authorization", "Bearer " + moderator.token);
    assert.equal(res.status, 403);
  });

  await t.test("validates and lists in time order", async function () {
    var res = await request(app)
      .post("/api/admin/schedule")
      .set("Authorization", auth)
      .send({ title: "Backwards", startsAt: "2026-10-24T15:00:00Z", endsAt: "2026-10-24T14:00:00Z" });
    assert.equal(res.status, 400);

    res = await request(app).post("/api/admin/schedule").set("Authorization", auth).send({ startsAt: "x" });
    assert.equal(res.status, 400);

    await request(app)
      .post("/api/admin/schedule")
      .set("Authorization", auth)
      .send({ title: "Judging", startsAt: "2026-10-25T14:00:00Z", endsAt: "2026-10-25T16:00:00Z" });
    res = await request(app)
      .post("/api/admin/schedule")
      .set("Authorization", auth)
      .send({ title: " Hacking starts ", startsAt: "2026-10-24T16:00:00Z", endsAt: "2026-10-24T16:30:00Z" });
    assert.equal(res.status, 201);
    assert.equal(res.body.event.title, "Hacking starts");

    res = await request(app).get("/api/admin/schedule").set("Authorization", auth);
    assert.deepEqual(
      res.body.events.map(function (e) {
        return e.title;
      }),
      ["Hacking starts", "Judging"]
    );
  });

  await t.test("updates and deletes", async function () {
    var list = await request(app).get("/api/admin/schedule").set("Authorization", auth);
    var id = list.body.events[0]._id;

    var res = await request(app)
      .patch("/api/admin/schedule/" + id)
      .set("Authorization", auth)
      .send({ location: "Room 101" });
    assert.equal(res.status, 200);
    assert.equal(res.body.event.location, "Room 101");

    res = await request(app)
      .patch("/api/admin/schedule/" + id)
      .set("Authorization", auth)
      .send({ endsAt: "2026-10-01T00:00:00Z" });
    assert.equal(res.status, 400, "can't move the end before the start");

    res = await request(app).delete("/api/admin/schedule/" + id).set("Authorization", auth);
    assert.equal(res.status, 200);
    res = await request(app).delete("/api/admin/schedule/" + id).set("Authorization", auth);
    assert.equal(res.status, 404);
  });

  await t.test("long .ics lines are folded at 75 octets", function () {
    var ics = calendar.buildRunOfShowIcs(
      [
        {
          _id: "abc",
          title: "Workshop: " + "é".repeat(80),
          startsAt: new Date("2026-10-24T14:00:00Z"),
          endsAt: new Date("2026-10-24T15:00:00Z"),
        },
      ],
      { orgName: "Test Org" }
    );
    ics.split("\r\n").forEach(function (line) {
      assert.ok(Buffer.byteLength(line) <= 75, "line too long: " + line);
    });
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  });

  await db.closeDatabase();
});
