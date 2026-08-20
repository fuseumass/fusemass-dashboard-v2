"use strict";

var path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var express = require("express");
var mongoose = require("mongoose");
var jwt = require("jsonwebtoken");

var adminRouter = require("../routes/admin");
var parseToken = require("../utils/parseToken");
var MealService = require("../schemas/mealService");

var app;
var adminToken;
var createdMealId;

var MONGODB_URI = process.env.MONGODB_URI;
var JWT_SECRET = process.env.JWT_SECRET;

function buildApp() {
  var api = express();
  api.use(express.json());
  api.use(parseToken);
  api.use("/api/admin", adminRouter);
  return api;
}

function makeAdminToken() {
  return jwt.sign({ id: new mongoose.Types.ObjectId().toString(), email: "admin@example.com", role: "admin" }, JWT_SECRET, { expiresIn: "1h" });
}

test.before(async function () {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await MealService.deleteMany({});

  app = buildApp();
  adminToken = makeAdminToken();
});

test.after(async function () {
  await MealService.deleteMany({});
  await mongoose.disconnect();
});

test("admin meal CRUD: create", async function () {
  var payload = {
    name: "8_13_2026_Lunch",
    startsAt: "2026-08-13T12:00:00.000Z",
    endsAt: "2026-08-13T13:00:00.000Z",
    active: true,
  };

  var response = await request(app)
    .post("/api/admin/meals")
    .set("Authorization", "Bearer " + adminToken)
    .send(payload)
    .expect(201);

  assert.equal(response.body.meal.name, payload.name);
  assert.equal(response.body.meal.active, true);
  createdMealId = response.body.meal._id;
  assert.ok(createdMealId, "meal id should be returned on create");
});

test("admin meal CRUD: read", async function () {
  var response = await request(app)
    .get("/api/admin/meals")
    .set("Authorization", "Bearer " + adminToken)
    .expect(200);

  assert.ok(Array.isArray(response.body.meals), "meals should be an array");
  assert.ok(response.body.meals.some(function (meal) {
    return meal._id === createdMealId && meal.name === "8_13_2026_Lunch";
  }), "created meal should be included in list");
});

test("admin meal CRUD: update", async function () {
  var response = await request(app)
    .patch("/api/admin/meals/" + createdMealId)
    .set("Authorization", "Bearer " + adminToken)
    .send({
      name: "8_13_2026_Lunch",
      active: false,
      endsAt: "2026-08-13T14:00:00.000Z",
    })
    .expect(200);

  assert.equal(response.body.meal._id, createdMealId);
  assert.equal(response.body.meal.active, false);
  assert.equal(response.body.meal.name, "8_13_2026_Lunch");
});

test("admin meal CRUD: delete", async function () {
  var response = await request(app)
    .delete("/api/admin/meals/" + createdMealId)
    .set("Authorization", "Bearer " + adminToken)
    .expect(200);

  assert.equal(response.body.ok, true);

  var readAfterDelete = await MealService.findById(createdMealId);
  assert.equal(readAfterDelete, null);
});
