"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var ApplicationRound = require("../schemas/applicationRound");

/**
 * Fresh DB before every subtest.
 * @returns {Promise<void>}
 */
function reset() {
  return db.clearDatabase();
}

test("T4: per-round form builder (B8 + B9)", async function roundFormBuilder(t) {
  await db.connect();

  await t.test("moderators cannot edit a round's form (admin-only guard)", async function () {
    await reset();
    var round = await ApplicationRound.create({ name: "Guarded Round" });
    var moderator = await fixtures.createUser({ role: "moderator" });

    var res = await request(app)
      .patch("/api/admin/rounds/" + round._id)
      .set("Authorization", "Bearer " + moderator.token)
      .send({ formConfig: [{ key: "x", label: "X", type: "text" }] });
    assert.equal(res.status, 403);

    var unchanged = await ApplicationRound.findById(round._id);
    assert.deepEqual(unchanged.formConfig, []);
  });

  await t.test("admin PATCH rejects a formConfig field with an unknown type", async function () {
    await reset();
    var round = await ApplicationRound.create({ name: "R1" });
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await request(app)
      .patch("/api/admin/rounds/" + round._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ formConfig: [{ key: "x", label: "X", type: "not-a-type" }] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /type must be one of/);
  });

  await t.test("admin PATCH rejects duplicate field keys", async function () {
    await reset();
    var round = await ApplicationRound.create({ name: "R2" });
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await request(app)
      .patch("/api/admin/rounds/" + round._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({
        formConfig: [
          { key: "dup", label: "A", type: "text" },
          { key: "dup", label: "B", type: "text" },
        ],
      });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /already used/);
  });

  await t.test("admin PATCH accepts and persists a valid formConfig", async function () {
    await reset();
    var round = await ApplicationRound.create({ name: "R3" });
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await request(app)
      .patch("/api/admin/rounds/" + round._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({
        formConfig: [
          { key: "dietary", label: "Dietary restriction", type: "select", required: true, options: ["none", "vegan"] },
        ],
      });
    assert.equal(res.status, 200);

    var stored = await ApplicationRound.findById(round._id);
    assert.equal(stored.formConfig[0].key, "dietary");
    assert.equal(stored.formConfig[0].required, true);
  });

  await t.test("submitting without a required dynamic field is rejected", async function () {
    await reset();
    await ApplicationRound.create({
      name: "Submission Round",
      isOpen: true,
      formConfig: [{ key: "dietary", label: "Dietary restriction", type: "select", required: true, options: ["none", "vegan"] }],
    });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Test Applicant")
      .field("status", "pending");
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Dietary restriction/);
  });

  await t.test("submitting an invalid option for a select field is rejected", async function () {
    await reset();
    await ApplicationRound.create({
      name: "Submission Round 2",
      isOpen: true,
      formConfig: [{ key: "dietary", label: "Dietary restriction", type: "select", required: true, options: ["none", "vegan"] }],
    });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Test Applicant")
      .field("status", "pending")
      .field("answers", JSON.stringify({ dietary: "pizza" }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /must be one of/);
  });

  await t.test("valid answers persist on the application, unknown keys are dropped", async function () {
    await reset();
    await ApplicationRound.create({
      name: "Submission Round 3",
      isOpen: true,
      formConfig: [
        { key: "dietary", label: "Dietary restriction", type: "select", required: true, options: ["none", "vegan"] },
        { key: "notes", label: "Notes", type: "textarea", required: false },
      ],
    });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Test Applicant")
      .field("status", "pending")
      .field("answers", JSON.stringify({ dietary: "vegan", notes: "hello", hacked: "evil" }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.application.answers, { dietary: "vegan", notes: "hello" });
  });

  await t.test("draft submissions skip required dynamic field validation", async function () {
    await reset();
    await ApplicationRound.create({
      name: "Submission Round 4",
      isOpen: true,
      formConfig: [{ key: "dietary", label: "Dietary restriction", type: "select", required: true, options: ["none", "vegan"] }],
    });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Draft Applicant")
      .field("status", "draft");
    assert.equal(res.status, 200);
    assert.equal(res.body.application.status, "draft");
  });

  await db.closeDatabase();
});
