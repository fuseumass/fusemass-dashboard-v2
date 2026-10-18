"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var crypto = require("crypto");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var qrCode = require("../utils/qrCode");
var mailer = require("../utils/mailer");
var User = require("../schemas/user");
var EmailTemplate = require("../schemas/emailTemplate");
var ApplicationRound = require("../schemas/applicationRound");
var Application = require("../schemas/application");
var CheckIn = require("../schemas/checkin");
var MealService = require("../schemas/mealService");
var MealCheckIn = require("../schemas/mealCheckin");

/**
 * Fresh DB + seeded templates, with the unique indexes the double-check-in
 * guards rely on already built.
 * @returns {Promise<void>}
 */
function resetFixtures() {
  return db
    .clearDatabase()
    .then(function afterClear() {
      return Promise.all([User.init(), CheckIn.init(), MealCheckIn.init()]);
    })
    .then(function afterIndexes() {
      return EmailTemplate.seedDefaults();
    });
}

/**
 * Create a user with an application in the given status.
 * @param {string} status - Application status.
 * @param {object} [overrides] - User fields (name, email).
 * @returns {Promise<{user: object, token: string, application: object}>}
 */
function createApplicant(status, overrides) {
  return Promise.all([
    fixtures.createUser(Object.assign({ role: "applicant" }, overrides || {})),
    ApplicationRound.create({ name: "Round " + Math.random(), isOpen: true }),
  ]).then(function afterCreate(results) {
    var applicant = results[0];
    return Application.create({
      applicant: applicant.user._id,
      round: results[1]._id,
      name: applicant.user.name,
      status: status,
    }).then(function afterApplication(application) {
      return Object.assign({ application: application }, applicant);
    });
  });
}

/**
 * An accepted applicant who has been issued their check-in code.
 * @param {object} [overrides] - User fields (name, email).
 * @returns {Promise<{user: object, token: string, qrId: string}>}
 */
function createAcceptedAttendee(overrides) {
  return createApplicant("accepted", overrides).then(function afterCreate(attendee) {
    return User.ensureQrId(attendee.user._id).then(function afterQrId(qrId) {
      return Object.assign({ qrId: qrId }, attendee);
    });
  });
}

/**
 * @param {string} name - Meal name.
 * @param {boolean} [active] - Whether the meal is active (default true).
 * @returns {Promise<object>} The MealService document.
 */
function createMeal(name, active) {
  return MealService.create({
    name: name,
    startsAt: new Date("2026-10-24T12:00:00Z"),
    endsAt: new Date("2026-10-24T13:00:00Z"),
    active: active !== false,
  });
}

test("check-in QR codes", async function qrCodes(t) {
  await db.connect();

  await t.test("are the SHA-256 of the normalized email", function () {
    var qrId = qrCode.computeQrId("Ada@Example.com ");
    assert.match(qrId, /^[a-f0-9]{64}$/);
    assert.equal(qrId, qrCode.computeQrId("ada@example.com"), "email is normalized");
    assert.notEqual(qrId, qrCode.computeQrId("grace@example.com"));
    assert.equal(qrId, crypto.createHash("sha256").update("ada@example.com").digest("hex"));
  });

  await t.test("normalizes scanner input and rejects anything else", function () {
    var qrId = qrCode.computeQrId("ada@example.com");
    assert.equal(qrCode.normalizeQrId(" " + qrId.toUpperCase() + "\n"), qrId);
    assert.equal(qrCode.normalizeQrId("not-a-code"), "");
    assert.equal(qrCode.normalizeQrId(undefined), "");
  });

  await t.test("accepting an application emails the QR inline and stores the code", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var applicant = await createApplicant("pending");
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await request(app)
      .patch("/api/admin/applications/" + applicant.application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "accepted" });
    assert.equal(res.status, 200);

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    var sent = mail.calls[0];
    assert.equal(sent.attachments.length, 1);
    assert.equal(sent.attachments[0].cid, "checkin-qrcode");
    assert.ok(Buffer.isBuffer(sent.attachments[0].content), "QR is attached as a PNG buffer");
    assert.match(sent.html, /<img src="cid:checkin-qrcode"/);
    assert.doesNotMatch(sent.html, /%%CHECKIN_QR_CODE%%|\{\{\s*qrcode\s*\}\}/);
    assert.match(sent.text, /QR code is attached/);

    var saved = await User.findById(applicant.user._id);
    assert.equal(saved.qrId, qrCode.computeQrId(applicant.user.email));
  });

  await t.test("no {{qrcode}} in the template means no QR", async function (t2) {
    await resetFixtures();
    await EmailTemplate.updateOne({ key: "application_accepted" }, { $set: { body: "Welcome, {{name}}!" } });
    var mail = mailMock.mockTransport(t2);
    var applicant = await createApplicant("pending");
    var admin = await fixtures.createUser({ role: "admin" });

    await request(app)
      .patch("/api/admin/applications/" + applicant.application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "accepted" });

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.equal(mail.calls[0].attachments, undefined);
    assert.doesNotMatch(mail.calls[0].html, /<img/);
  });

  await t.test("{{qrcode}} works in any template, with the recipient's own code", async function (t2) {
    await resetFixtures();
    await EmailTemplate.updateOne(
      { key: "application_received" },
      { $set: { body: "Thanks {{name}}! Your code: {{ qrcode }} (keep it)" } }
    );
    var mail = mailMock.mockTransport(t2);
    var applicant = await fixtures.createUser({ role: "applicant", email: "Grace@Example.com" });

    await mailer.sendTemplateEmail(applicant.user.email, "application_received", { name: "Grace" });

    var sent = mail.calls[0];
    assert.equal(sent.attachments.length, 1);
    assert.equal(sent.attachments[0].cid, "checkin-qrcode");
    // The image sits where the variable was, not at the end.
    assert.match(sent.html, /Your code: <img src="cid:checkin-qrcode"[^>]*> \(keep it\)/);
    var saved = await User.findById(applicant.user._id);
    assert.equal(saved.qrId, crypto.createHash("sha256").update("grace@example.com").digest("hex"));
  });

  await t.test("the QR image decodes to the SHA-256 of the email", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var applicant = await createApplicant("pending", { email: "ada@example.com" });
    var admin = await fixtures.createUser({ role: "admin" });

    await request(app)
      .patch("/api/admin/applications/" + applicant.application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "accepted" });
    await waitFor(function () {
      return mail.calls.length >= 1;
    });

    // Render the same code with the same settings: the PNG must be identical,
    // so what's in the email encodes exactly sha256("ada@example.com").
    var expected = await qrCode.toPngBuffer(crypto.createHash("sha256").update("ada@example.com").digest("hex"));
    assert.ok(mail.calls[0].attachments[0].content.equals(expected));
  });

  await t.test("seeding upgrades an unedited old acceptance template, never an edited one", async function () {
    await db.clearDatabase();
    var oldDefault =
      "Hi {{name}},\n\nCongratulations! Your application to {{orgName}} has been accepted.\n\nStatus: {{status}}";
    await EmailTemplate.create({ key: "application_accepted", subject: "s", body: oldDefault });
    await EmailTemplate.seedDefaults();
    var upgraded = await EmailTemplate.findOne({ key: "application_accepted" });
    assert.match(upgraded.body, /\{\{qrcode\}\}/);

    await EmailTemplate.updateOne({ key: "application_accepted" }, { $set: { body: oldDefault + " edited" } });
    await EmailTemplate.seedDefaults();
    var edited = await EmailTemplate.findOne({ key: "application_accepted" });
    assert.equal(edited.body, oldDefault + " edited");
  });

  await t.test("admin preview renders the QR inline; test send emails the admin", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var admin = await fixtures.createUser({ role: "admin", name: "Ada Admin" });
    var auth = "Bearer " + admin.token;
    var draft = { subject: "Hi {{name}}", body: "Scan this:\n{{qrcode}}" };

    var res = await request(app).post("/api/admin/email-templates/preview").set("Authorization", auth).send(draft);
    assert.equal(res.status, 200);
    assert.equal(res.body.subject, "Hi Ada Admin");
    assert.equal(res.body.hasQrCode, true);
    assert.match(res.body.html, /<img src="data:image\/png;base64,/);

    res = await request(app).post("/api/admin/email-templates/test").set("Authorization", auth).send(draft);
    assert.equal(res.status, 200);
    assert.equal(res.body.sentTo, admin.user.email);
    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, admin.user.email);
    assert.match(mail.calls[0].subject, /^\[Test\] Hi Ada Admin/);
    assert.equal(mail.calls[0].attachments[0].cid, "checkin-qrcode");

    var applicant = await fixtures.createUser({ role: "applicant" });
    res = await request(app)
      .post("/api/admin/email-templates/preview")
      .set("Authorization", "Bearer " + applicant.token)
      .send(draft);
    assert.equal(res.status, 403);
  });

  await t.test("rejection emails carry no QR code", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var applicant = await createApplicant("pending");
    var admin = await fixtures.createUser({ role: "admin" });

    await request(app)
      .patch("/api/admin/applications/" + applicant.application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "rejected" });

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.equal(mail.calls[0].attachments, undefined);
    var saved = await User.findById(applicant.user._id);
    assert.equal(saved.qrId, undefined);
  });

  await t.test("GET /api/applications/me/qr is only available once accepted", async function () {
    await resetFixtures();
    var pending = await createApplicant("pending");
    var res = await request(app).get("/api/applications/me/qr").set("Authorization", "Bearer " + pending.token);
    assert.equal(res.status, 404);

    // Accepted in a round that has since closed: still gets the code, and it
    // is generated on demand for anyone accepted before codes existed.
    var accepted = await createApplicant("accepted");
    await ApplicationRound.updateMany({}, { $set: { isOpen: false } });
    res = await request(app).get("/api/applications/me/qr").set("Authorization", "Bearer " + accepted.token);
    assert.equal(res.status, 200);
    assert.equal(res.body.qrId, qrCode.computeQrId(accepted.user.email));
    assert.match(res.body.qrCode, /^data:image\/png;base64,/);
  });
});

test("T2: event check-in", async function eventCheckIn(t) {
  await db.connect();

  await t.test("requires a moderator or admin", async function () {
    await resetFixtures();
    var attendee = await createAcceptedAttendee();

    var res = await request(app).post("/api/staff/checkin").send({ qrId: attendee.qrId });
    assert.equal(res.status, 401);

    res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", "Bearer " + attendee.token)
      .send({ qrId: attendee.qrId });
    assert.equal(res.status, 403, "an applicant cannot check themselves in");
  });

  await t.test("checks an attendee in by QR, once", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var attendee = await createAcceptedAttendee({ name: "Ada Lovelace" });
    var moderator = await fixtures.createUser({ role: "moderator", name: "Mod Erator" });
    var auth = "Bearer " + moderator.token;

    var res = await request(app).post("/api/staff/checkin").set("Authorization", auth).send({ qrId: attendee.qrId });
    assert.equal(res.status, 201);
    assert.equal(res.body.attendee.name, "Ada Lovelace");
    assert.equal(res.body.attendee.email, attendee.user.email);

    res = await request(app).post("/api/staff/checkin").set("Authorization", auth).send({ qrId: attendee.qrId });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Ada Lovelace is already checked in/);
    assert.equal(res.body.checkedInBy, "Mod Erator");

    res = await request(app)
      .get("/api/staff/checkin/" + attendee.user._id)
      .set("Authorization", auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.checkedIn, true);
    assert.equal(res.body.checkedInBy.name, "Mod Erator");
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
  });

  await t.test("still works by userId (the search fallback)", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var attendee = await createAcceptedAttendee();
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", "Bearer " + admin.token)
      .send({ userId: String(attendee.user._id) });
    assert.equal(res.status, 201);
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
  });

  await t.test("rejects bad, unknown and not-accepted codes", async function () {
    await resetFixtures();
    var moderator = await fixtures.createUser({ role: "moderator" });
    var auth = "Bearer " + moderator.token;

    var res = await request(app).post("/api/staff/checkin").set("Authorization", auth).send({ qrId: "hello" });
    assert.equal(res.status, 400);

    res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", auth)
      .send({ qrId: qrCode.computeQrId("nobody@example.com") });
    assert.equal(res.status, 404);

    var waitlisted = await createApplicant("waitlisted");
    var waitlistedQr = await User.ensureQrId(waitlisted.user._id);
    res = await request(app).post("/api/staff/checkin").set("Authorization", auth).send({ qrId: waitlistedQr });
    assert.equal(res.status, 400);

    res = await request(app).post("/api/staff/checkin").set("Authorization", auth).send({});
    assert.equal(res.status, 400);

    res = await request(app).post("/api/staff/checkin").set("Authorization", auth).send({ userId: "nope" });
    assert.equal(res.status, 400);
  });

  await t.test("forced check-in: needs a reason, records it, then works like a check-in", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var walkIn = await createApplicant("rejected", { name: "Walk In" });
    var walkInQr = await User.ensureQrId(walkIn.user._id);
    var moderator = await fixtures.createUser({ role: "moderator" });
    var auth = "Bearer " + moderator.token;

    // A normal scan explains why and hands back who it was, so the screen can
    // offer a forced check-in.
    var res = await request(app).post("/api/staff/checkin").set("Authorization", auth).send({ qrId: walkInQr });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "not_accepted");
    assert.equal(res.body.attendee.name, "Walk In");
    assert.equal(res.body.attendee.applicationStatus, "rejected");

    res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", auth)
      .send({ qrId: walkInQr, force: true });
    assert.equal(res.status, 400, "a reason is required");

    res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", auth)
      .send({ qrId: walkInQr, force: true, reason: "Approved walk-in" });
    assert.equal(res.status, 201);
    assert.equal(res.body.forced, true);

    var record = await CheckIn.findOne({ user: walkIn.user._id });
    assert.equal(record.forced, true);
    assert.equal(record.forcedReason, "Approved walk-in");
    assert.equal(record.applicationStatus, "rejected");
    assert.equal((await User.findById(walkIn.user._id)).checkedIn, true);

    res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", auth)
      .send({ qrId: walkInQr, force: true, reason: "again" });
    assert.equal(res.status, 409, "still once per person");

    // Someone with no application at all can be forced in too (by user id).
    var noApp = await fixtures.createUser({ role: "applicant" });
    res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", auth)
      .send({ userId: String(noApp.user._id), force: true, reason: "Organizer's guest" });
    assert.equal(res.status, 201);

    res = await request(app).get("/api/staff/checkin/stats").set("Authorization", auth);
    assert.equal(res.body.forced, 2);

    // Forcing an accepted attendee is just a normal check-in.
    var accepted = await createAcceptedAttendee();
    res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", auth)
      .send({ qrId: accepted.qrId, force: true, reason: "habit" });
    assert.equal(res.status, 201);
    assert.equal(res.body.forced, false);
    // Forced check-ins get the same checked-in email (3 check-ins above).
    await waitFor(function () {
      return mail.calls.length >= 3;
    });
  });

  await t.test("force-checked-in attendees can be served meals", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var walkIn = await createApplicant("waitlisted");
    var qrId = await User.ensureQrId(walkIn.user._id);
    var moderator = await fixtures.createUser({ role: "moderator" });
    var auth = "Bearer " + moderator.token;
    var lunch = await createMeal("Saturday Lunch");

    var res = await request(app).post("/api/staff/meals/" + lunch._id + "/checkin").set("Authorization", auth).send({ qrId: qrId });
    assert.equal(res.status, 400, "not accepted and not checked in");

    await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", auth)
      .send({ qrId: qrId, force: true, reason: "Approved walk-in" });
    res = await request(app).post("/api/staff/meals/" + lunch._id + "/checkin").set("Authorization", auth).send({ qrId: qrId });
    assert.equal(res.status, 201);
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
  });

  await t.test("a scan whose code was lost is rebuilt from the email", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var attendee = await createAcceptedAttendee({ email: "lost@example.com" });
    await User.updateOne({ _id: attendee.user._id }, { $unset: { qrId: 1 } });
    var moderator = await fixtures.createUser({ role: "moderator" });

    var res = await request(app)
      .post("/api/staff/checkin")
      .set("Authorization", "Bearer " + moderator.token)
      .send({ qrId: crypto.createHash("sha256").update("lost@example.com").digest("hex") });
    assert.equal(res.status, 201);
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.equal((await User.findById(attendee.user._id)).qrId, attendee.qrId);
  });

  await t.test("search with all=1 finds everyone, with their application status", async function () {
    await resetFixtures();
    await createAcceptedAttendee({ name: "Ada Accepted", email: "ada@example.com" });
    await createApplicant("rejected", { name: "Ada Rejected", email: "ada.r@example.com" });
    await fixtures.createUser({ role: "applicant", name: "Ada Noapp", email: "ada.n@example.com" });
    var moderator = await fixtures.createUser({ role: "moderator", name: "Ada Mod" });
    var auth = "Bearer " + moderator.token;

    var res = await request(app).get("/api/staff/attendees?q=ada&all=1").set("Authorization", auth);
    var byName = {};
    res.body.attendees.forEach(function (a) {
      byName[a.name] = a.applicationStatus;
    });
    assert.deepEqual(byName, { "Ada Accepted": "accepted", "Ada Noapp": "none", "Ada Rejected": "rejected" });

    res = await request(app).get("/api/staff/attendees?q=ada").set("Authorization", auth);
    assert.equal(res.body.attendees.length, 1, "without all=1, accepted only");
  });

  await t.test("attendee search finds accepted attendees only, with status", async function () {
    await resetFixtures();
    var ada = await createAcceptedAttendee({ name: "Ada Lovelace", email: "ada@example.com" });
    await createAcceptedAttendee({ name: "Grace Hopper", email: "grace@example.com" });
    await createApplicant("pending", { name: "Ada Pending", email: "pending@example.com" });
    var moderator = await fixtures.createUser({ role: "moderator" });
    var auth = "Bearer " + moderator.token;
    await CheckIn.create({ user: ada.user._id, checkedInBy: moderator.user._id });

    var res = await request(app).get("/api/staff/attendees?q=ada").set("Authorization", auth);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.attendees.map(function (a) {
        return a.name;
      }),
      ["Ada Lovelace"]
    );
    assert.equal(res.body.attendees[0].checkedIn, true);

    res = await request(app).get("/api/staff/attendees?q=GRACE@").set("Authorization", auth);
    assert.equal(res.body.attendees.length, 1);
    assert.equal(res.body.attendees[0].checkedIn, false);

    res = await request(app).get("/api/staff/attendees").set("Authorization", auth);
    assert.equal(res.body.attendees.length, 2);
  });
});

test("T3: meal check-in", async function mealCheckIn(t) {
  await db.connect();

  await t.test("admins can create an event-wide meal without createdFor", async function () {
    await resetFixtures();
    var admin = await fixtures.createUser({ role: "admin" });
    var res = await request(app)
      .post("/api/admin/meals")
      .set("Authorization", "Bearer " + admin.token)
      .send({ name: "Saturday Lunch", startsAt: "2026-10-24T12:00:00Z", endsAt: "2026-10-24T13:00:00Z" });
    assert.equal(res.status, 201);
    assert.equal(res.body.meal.createdFor, "");
  });

  await t.test("serves each attendee once per meal", async function () {
    await resetFixtures();
    var attendee = await createAcceptedAttendee({ name: "Ada Lovelace" });
    var moderator = await fixtures.createUser({ role: "moderator" });
    var auth = "Bearer " + moderator.token;
    var lunch = await createMeal("Saturday Lunch");
    var dinner = await createMeal("Saturday Dinner");

    var res = await request(app)
      .post("/api/staff/meals/" + lunch._id + "/checkin")
      .set("Authorization", auth)
      .send({ qrId: attendee.qrId });
    assert.equal(res.status, 201);
    assert.equal(res.body.attendee.name, "Ada Lovelace");
    assert.equal(res.body.attendee.eventCheckedIn, false);

    res = await request(app)
      .post("/api/staff/meals/" + lunch._id + "/checkin")
      .set("Authorization", auth)
      .send({ qrId: attendee.qrId });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already been served Saturday Lunch/);

    res = await request(app)
      .post("/api/staff/meals/" + dinner._id + "/checkin")
      .set("Authorization", auth)
      .send({ qrId: attendee.qrId });
    assert.equal(res.status, 201, "a different meal is fine");

    res = await request(app).get("/api/staff/meals").set("Authorization", auth);
    var counts = {};
    res.body.meals.forEach(function (meal) {
      counts[meal.name] = meal.checkInCount;
    });
    assert.deepEqual(counts, { "Saturday Lunch": 1, "Saturday Dinner": 1 });
  });

  await t.test("two simultaneous scans serve only once", async function () {
    await resetFixtures();
    var attendee = await createAcceptedAttendee();
    var moderator = await fixtures.createUser({ role: "moderator" });
    var lunch = await createMeal("Saturday Lunch");

    var scans = await Promise.all(
      [1, 2, 3].map(function scan() {
        return request(app)
          .post("/api/staff/meals/" + lunch._id + "/checkin")
          .set("Authorization", "Bearer " + moderator.token)
          .send({ qrId: attendee.qrId });
      })
    );
    var statuses = scans
      .map(function (r) {
        return r.status;
      })
      .sort();
    assert.deepEqual(statuses, [201, 409, 409]);
    assert.equal(await MealCheckIn.countDocuments({}), 1);
  });

  await t.test("refuses inactive and unknown meals, and applicants", async function () {
    await resetFixtures();
    var attendee = await createAcceptedAttendee();
    var moderator = await fixtures.createUser({ role: "moderator" });
    var auth = "Bearer " + moderator.token;
    var closed = await createMeal("Friday Dinner", false);

    var res = await request(app)
      .post("/api/staff/meals/" + closed._id + "/checkin")
      .set("Authorization", auth)
      .send({ qrId: attendee.qrId });
    assert.equal(res.status, 400);

    res = await request(app)
      .post("/api/staff/meals/not-an-id/checkin")
      .set("Authorization", auth)
      .send({ qrId: attendee.qrId });
    assert.equal(res.status, 404);

    var open = await createMeal("Saturday Lunch");
    res = await request(app)
      .post("/api/staff/meals/" + open._id + "/checkin")
      .set("Authorization", "Bearer " + attendee.token)
      .send({ qrId: attendee.qrId });
    assert.equal(res.status, 403);
  });

  await t.test("a meal with check-ins cannot be deleted", async function () {
    await resetFixtures();
    var attendee = await createAcceptedAttendee();
    var admin = await fixtures.createUser({ role: "admin" });
    var auth = "Bearer " + admin.token;
    var lunch = await createMeal("Saturday Lunch");

    await request(app)
      .post("/api/staff/meals/" + lunch._id + "/checkin")
      .set("Authorization", auth)
      .send({ qrId: attendee.qrId });

    var res = await request(app).delete("/api/admin/meals/" + lunch._id).set("Authorization", auth);
    assert.equal(res.status, 409);
    assert.ok(await MealService.findById(lunch._id), "meal is still there");

    res = await request(app).get("/api/admin/meals").set("Authorization", auth);
    assert.equal(res.body.meals[0].checkInCount, 1);
  });

  await db.closeDatabase();
});
