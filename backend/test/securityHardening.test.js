"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var ApplicationRound = require("../schemas/applicationRound");
var Application = require("../schemas/application");

test("T5: security / hardening", async function securityHardening(t) {
  await db.connect();

  // ---- Authz: no privilege escalation via request body -------------------

  await t.test("register ignores a role field in the body — always creates an applicant", async function () {
    await db.clearDatabase();

    var res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Sneaky", email: "sneaky@test.com", password: "whatever", role: "admin" });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, "applicant");
  });

  await t.test("only an admin can promote a user's role — moderator gets 403", async function () {
    await db.clearDatabase();
    var target = await fixtures.createUser({ role: "applicant" });
    var moderator = await fixtures.createUser({ role: "moderator" });

    var res = await request(app)
      .patch("/api/admin/users/" + target.user._id + "/role")
      .set("Authorization", "Bearer " + moderator.token)
      .send({ role: "admin" });
    assert.equal(res.status, 403);
  });

  await t.test("an applicant cannot decide (accept/reject) an application", async function () {
    await db.clearDatabase();
    var round = await ApplicationRound.create({ name: "R", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });
    var application = await Application.create({ applicant: applicant.user._id, round: round._id, status: "pending" });

    var res = await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + applicant.token)
      .send({ decision: "accepted" });
    assert.equal(res.status, 403);
  });

  // ---- Resume upload validation ------------------------------------------

  await t.test("resume upload rejects a wrong file type with a clean 400", async function () {
    await db.clearDatabase();
    await ApplicationRound.create({ name: "R", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Test")
      .field("status", "draft")
      .attach("resume", Buffer.from("not a resume"), { filename: "evil.txt", contentType: "text/plain" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /PDF or Word/);
  });

  await t.test("resume upload rejects an oversized file with a clean 400", async function () {
    await db.clearDatabase();
    await ApplicationRound.create({ name: "R", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var bigBuffer = Buffer.alloc(6 * 1024 * 1024, "a"); // 6MB > 5MB limit
    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Test")
      .field("status", "draft")
      .attach("resume", bigBuffer, { filename: "big.pdf", contentType: "application/pdf" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /5 MB/);
  });

  await db.closeDatabase();
});
