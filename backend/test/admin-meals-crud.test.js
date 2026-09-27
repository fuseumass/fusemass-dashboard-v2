"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var MealService = require("../schemas/mealService");

test("B6: admin meal service CRUD", async function adminMealCrud(t) {
  await db.connect();
  await db.clearDatabase();

  var admin = await fixtures.createUser({ role: "admin" });
  var auth = "Bearer " + admin.token;
  var createdMealId;

  await t.test("rejects unauthenticated requests", async function () {
    var res = await request(app).get("/api/admin/meals");
    assert.equal(res.status, 401);
  });

  await t.test("rejects non-admin roles", async function () {
    var applicant = await fixtures.createUser({ role: "applicant" });
    var res = await request(app)
      .get("/api/admin/meals")
      .set("Authorization", "Bearer " + applicant.token);
    assert.equal(res.status, 403);
  });

  await t.test("create", async function () {
    var payload = {
      name: "8_13_2026_Lunch",
      startsAt: "2026-08-13T12:00:00.000Z",
      endsAt: "2026-08-13T13:00:00.000Z",
      active: true,
    };

    var res = await request(app).post("/api/admin/meals").set("Authorization", auth).send(payload);

    assert.equal(res.status, 201);
    assert.equal(res.body.meal.name, payload.name);
    assert.equal(res.body.meal.active, true);
    createdMealId = res.body.meal._id;
    assert.ok(createdMealId, "meal id should be returned on create");
  });

  await t.test("list", async function () {
    var res = await request(app).get("/api/admin/meals").set("Authorization", auth);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.meals), "meals should be an array");
    assert.ok(
      res.body.meals.some(function isCreated(meal) {
        return meal._id === createdMealId && meal.name === "8_13_2026_Lunch";
      }),
      "created meal should be included in list"
    );
  });

  await t.test("update", async function () {
    var res = await request(app)
      .patch("/api/admin/meals/" + createdMealId)
      .set("Authorization", auth)
      .send({ name: "8_13_2026_Lunch", active: false, endsAt: "2026-08-13T14:00:00.000Z" });

    assert.equal(res.status, 200);
    assert.equal(res.body.meal._id, createdMealId);
    assert.equal(res.body.meal.active, false);
    assert.equal(res.body.meal.name, "8_13_2026_Lunch");
  });

  await t.test("delete", async function () {
    var res = await request(app).delete("/api/admin/meals/" + createdMealId).set("Authorization", auth);

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(await MealService.findById(createdMealId), null);
  });

  await db.closeDatabase();
});
