"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var EmailTemplate = require("../schemas/emailTemplate");
var ApplicationRound = require("../schemas/applicationRound");
var Application = require("../schemas/application");

/**
 * Fresh DB + seeded templates before every subtest.
 * @returns {Promise<void>}
 */
function resetFixtures() {
  return db.clearDatabase().then(function afterClear() {
    return EmailTemplate.seedDefaults();
  });
}

/**
 * Create a pending application directly (bypassing the submit endpoint,
 * since these tests are about the decision step, not submission).
 * @param {object} applicant - {user, token} from fixtures.createUser.
 * @returns {Promise<object>} The created Application document.
 */
function createPendingApplication(applicant) {
  return ApplicationRound.create({ name: "Review Round", isOpen: true }).then(function afterRound(round) {
    return Application.create({
      applicant: applicant.user._id,
      round: round._id,
      name: applicant.user.name,
      status: "pending",
    });
  });
}

test("B3: decision emails on accept/reject", async function decisionEmails(t) {
  await db.connect();

  await t.test("accepting a pending application sends exactly one accepted email", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var applicant = await fixtures.createUser({ role: "applicant" });
    var admin = await fixtures.createUser({ role: "admin" });
    var application = await createPendingApplication(applicant);

    var res = await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "accepted" });
    assert.equal(res.status, 200);

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, applicant.user.email);
    assert.match(mail.calls[0].subject, /accepted/i);
  });

  await t.test("rejecting a pending application sends exactly one rejected email", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var applicant = await fixtures.createUser({ role: "applicant" });
    var admin = await fixtures.createUser({ role: "admin" });
    var application = await createPendingApplication(applicant);

    var res = await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "rejected" });
    assert.equal(res.status, 200);

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.equal(mail.calls.length, 1);
    assert.match(mail.calls[0].subject, /not selected|rejected/i);
  });

  await t.test("re-applying the same decision does not re-send (idempotent)", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var applicant = await fixtures.createUser({ role: "applicant" });
    var admin = await fixtures.createUser({ role: "admin" });
    var application = await createPendingApplication(applicant);

    var first = await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "accepted" });
    assert.equal(first.status, 200);

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.equal(mail.calls.length, 1);

    var second = await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "accepted" });
    assert.equal(second.status, 200);

    await new Promise(function (resolve) {
      setTimeout(resolve, 150);
    });
    assert.equal(mail.calls.length, 1);
  });

  await t.test("changing an existing decision sends the new one", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var applicant = await fixtures.createUser({ role: "applicant" });
    var admin = await fixtures.createUser({ role: "admin" });
    var application = await createPendingApplication(applicant);

    await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "accepted" });
    await waitFor(function () {
      return mail.calls.length >= 1;
    });

    await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "rejected" });
    await waitFor(function () {
      return mail.calls.length >= 2;
    });

    assert.equal(mail.calls.length, 2);
    assert.match(mail.calls[1].subject, /not selected|rejected/i);
  });

  await t.test("moving to waitlisted/pending sends no decision email", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var applicant = await fixtures.createUser({ role: "applicant" });
    var admin = await fixtures.createUser({ role: "admin" });
    var application = await createPendingApplication(applicant);

    var res = await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ decision: "waitlisted" });
    assert.equal(res.status, 200);

    await new Promise(function (resolve) {
      setTimeout(resolve, 150);
    });
    assert.equal(mail.calls.length, 0);
  });

  await db.closeDatabase();
});
