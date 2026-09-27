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

/**
 * Fresh DB + seeded templates before every subtest, so each one gets its own
 * isolated open round instead of tripping over a previous subtest's.
 * @returns {Promise<void>}
 */
function resetFixtures() {
  return db.clearDatabase().then(function afterClear() {
    return EmailTemplate.seedDefaults();
  });
}

test("B2 + B4: application-received email on submit", async function applicationReceivedEmail(t) {
  await db.connect();

  await t.test("submitting an application sends exactly one received email, with safely-escaped html", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    var round = await ApplicationRound.create({ name: "Test Round", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "O'Brien & <Friends>")
      .field("status", "pending");

    assert.equal(res.status, 200);
    assert.equal(res.body.application.round, String(round._id));

    await waitFor(function () {
      return mail.calls.length >= 1;
    });

    assert.equal(mail.calls.length, 1);
    var sent = mail.calls[0];
    assert.equal(sent.to, applicant.user.email);
    // Plain-text body keeps the raw name (readable, not HTML-escaped).
    assert.match(sent.text, /O'Brien & <Friends>/);
    // HTML body must not let the name's markup pass through unescaped.
    assert.doesNotMatch(sent.html, /<Friends>/);
    assert.match(sent.html, /&lt;Friends&gt;/);
  });

  await t.test("re-saving an already-submitted application does not re-send", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    await ApplicationRound.create({ name: "Another Round", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var first = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Alex Applicant")
      .field("status", "pending");
    assert.equal(first.status, 200);

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.equal(mail.calls.length, 1);

    var second = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Alex Applicant (edited)")
      .field("status", "pending");
    assert.equal(second.status, 200);

    // Give a re-send a chance to happen before asserting it didn't.
    await new Promise(function (resolve) {
      setTimeout(resolve, 150);
    });
    assert.equal(mail.calls.length, 1);
  });

  await t.test("saving as a draft does not send an email", async function (t2) {
    await resetFixtures();
    var mail = mailMock.mockTransport(t2);
    await ApplicationRound.create({ name: "Draft Round", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Drafty McDraftface")
      .field("status", "draft");
    assert.equal(res.status, 200);
    assert.equal(res.body.application.status, "draft");

    await new Promise(function (resolve) {
      setTimeout(resolve, 150);
    });
    assert.equal(mail.calls.length, 0);
  });

  await db.closeDatabase();
});
