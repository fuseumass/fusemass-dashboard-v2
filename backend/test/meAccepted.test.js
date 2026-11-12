"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");

/**
 * @param {object} person - From fixtures.createUser.
 * @returns {Promise<object>} The /api/auth/me user.
 */
async function me(person) {
  var res = await request(app).get("/api/auth/me").set("Authorization", "Bearer " + person.token);
  assert.equal(res.status, 200);
  return res.body.user;
}

test("/api/auth/me says whether the person is accepted", async function (t) {
  await db.connect();
  t.after(db.closeDatabase);
  await db.clearDatabase();
  var round = await ApplicationRound.create({ name: "General", isOpen: true });

  var accepted = await fixtures.createUser();
  await Application.create({ applicant: accepted.user._id, round: round._id, name: "A", status: "accepted" });
  var pending = await fixtures.createUser();
  await Application.create({ applicant: pending.user._id, round: round._id, name: "P", status: "pending" });
  var rejected = await fixtures.createUser();
  await Application.create({ applicant: rejected.user._id, round: round._id, name: "R", status: "rejected" });
  var none = await fixtures.createUser();
  var judge = await fixtures.createUser({ role: "judge" });

  assert.equal((await me(accepted)).accepted, true);
  assert.equal((await me(pending)).accepted, false);
  assert.equal((await me(rejected)).accepted, false);
  assert.equal((await me(none)).accepted, false);
  assert.equal((await me(judge)).accepted, false);
});
