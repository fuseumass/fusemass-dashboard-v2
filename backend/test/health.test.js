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

  await t.test("GET /api/health/db pings the database and reports it up", async function () {
    var res = await request(app).get("/api/health/db");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.db, "up");
    assert.equal(typeof res.body.latencyMs, "number");
    assert.equal(res.headers["cache-control"], "no-store");
  });

  await t.test("the disposable test database is reachable and writable", async function () {
    await EmailTemplate.seedDefaults();
    var count = await EmailTemplate.countDocuments({});
    assert.equal(count, EmailTemplate.BUILT_IN_KEYS.length);
  });

  await t.test("admin-only routes reject unauthenticated requests", async function () {
    var res = await request(app).get("/api/admin/email-templates");
    assert.equal(res.status, 401);
  });

  await db.closeDatabase();

  await t.test("GET /api/health/db reports 503 once the database is unreachable", async function () {
    var res = await request(app).get("/api/health/db");
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { ok: false, db: "down" });

    var liveness = await request(app).get("/api/health");
    assert.equal(liveness.status, 200, "liveness doesn't depend on the database");
  });
});
