"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var app = require("../server");
var EmailTemplate = require("../schemas/emailTemplate");

test("health + harness smoke test", async function harnessSmokeTest(t) {
  await db.connect();
  await db.clearDatabase();

  await t.test("GET /api/health responds without touching the database", async function () {
    var res = await request(app).get("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  await t.test("the disposable test database is reachable and writable", async function () {
    await EmailTemplate.seedDefaults();
    var count = await EmailTemplate.countDocuments({});
    assert.equal(count, 3);
  });

  await t.test("admin-only routes reject unauthenticated requests", async function () {
    var res = await request(app).get("/api/admin/email-templates");
    assert.equal(res.status, 401);
  });

  await db.closeDatabase();
});
