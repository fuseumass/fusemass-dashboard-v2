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
      ["application_accepted", "application_received", "application_rejected"].sort()
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

  await db.closeDatabase();
});
