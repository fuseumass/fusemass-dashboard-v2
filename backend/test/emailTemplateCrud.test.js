"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var EmailTemplate = require("../schemas/emailTemplate");

test("B1: email template CRUD", async function emailTemplateCrud(t) {
  await db.connect();
  await db.clearDatabase();

  await t.test("GET rejects unauthenticated requests", async function () {
    var res = await request(app).get("/api/admin/email-templates");
    assert.equal(res.status, 401);
  });

  await t.test("GET rejects non-admin roles", async function () {
    var applicant = await fixtures.createUser({ role: "applicant" });
    var res = await request(app)
      .get("/api/admin/email-templates")
      .set("Authorization", "Bearer " + applicant.token);
    assert.equal(res.status, 403);
  });

  await t.test("seeded defaults are all present for an admin", async function () {
    await EmailTemplate.seedDefaults();
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await request(app)
      .get("/api/admin/email-templates")
      .set("Authorization", "Bearer " + admin.token);

    assert.equal(res.status, 200);
    var keys = res.body.templates.map(function pluckKey(tpl) {
      return tpl.key;
    });
    assert.deepEqual(
      keys.sort(),
      ["account_setup", "application_accepted", "application_received", "application_rejected", "checked_in", "team_invite"].sort()
    );
  });

  await t.test("admin can create, update, and delete a template", async function () {
    var admin = await fixtures.createUser({ role: "admin" });

    var createRes = await request(app)
      .post("/api/admin/email-templates")
      .set("Authorization", "Bearer " + admin.token)
      .send({ key: "custom_test_template", subject: "Hi {{name}}", body: "Body for {{name}}" });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.template.key, "custom_test_template");
    var id = createRes.body.template._id;

    var updateRes = await request(app)
      .patch("/api/admin/email-templates/" + id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ subject: "Updated subject" });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.template.subject, "Updated subject");

    var deleteRes = await request(app)
      .delete("/api/admin/email-templates/" + id)
      .set("Authorization", "Bearer " + admin.token);
    assert.equal(deleteRes.status, 200);

    var stillThere = await EmailTemplate.findById(id);
    assert.equal(stillThere, null);
  });

  await t.test("a built-in template cannot be renamed", async function () {
    await EmailTemplate.seedDefaults();
    var admin = await fixtures.createUser({ role: "admin" });
    var builtIn = await EmailTemplate.findOne({ key: "application_received" });

    var res = await request(app)
      .patch("/api/admin/email-templates/" + builtIn._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ key: "renamed_by_admin" });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /cannot be renamed/);

    var unchanged = await EmailTemplate.findById(builtIn._id);
    assert.equal(unchanged.key, "application_received");
  });

  await t.test("a built-in template cannot be deleted", async function () {
    await EmailTemplate.seedDefaults();
    var admin = await fixtures.createUser({ role: "admin" });
    var builtIn = await EmailTemplate.findOne({ key: "application_accepted" });

    var res = await request(app)
      .delete("/api/admin/email-templates/" + builtIn._id)
      .set("Authorization", "Bearer " + admin.token);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /cannot be deleted/);

    var stillThere = await EmailTemplate.findById(builtIn._id);
    assert.ok(stillThere, "expected the built-in template to survive the delete attempt");
  });

  await t.test("a built-in template's subject and body remain editable", async function () {
    await EmailTemplate.seedDefaults();
    var admin = await fixtures.createUser({ role: "admin" });
    var builtIn = await EmailTemplate.findOne({ key: "application_rejected" });

    var res = await request(app)
      .patch("/api/admin/email-templates/" + builtIn._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ subject: "Edited subject", body: "Edited body for {{name}}" });

    assert.equal(res.status, 200);
    assert.equal(res.body.template.subject, "Edited subject");
    assert.equal(res.body.template.key, "application_rejected");
  });

  await t.test("sending the same key twice is a no-op rename, not a rejection", async function () {
    await EmailTemplate.seedDefaults();
    var admin = await fixtures.createUser({ role: "admin" });
    var builtIn = await EmailTemplate.findOne({ key: "application_received" });

    var res = await request(app)
      .patch("/api/admin/email-templates/" + builtIn._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ key: "application_received", subject: "Still fine" });

    assert.equal(res.status, 200);
    assert.equal(res.body.template.subject, "Still fine");
  });

  await db.closeDatabase();
});
