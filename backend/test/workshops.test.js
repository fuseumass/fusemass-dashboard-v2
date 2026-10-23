"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var Workshop = require("../schemas/workshop");
var Signup = require("../schemas/workshopSignup");
var Application = require("../schemas/application");
var Round = require("../schemas/applicationRound");
var Template = require("../schemas/emailTemplate");
var Settings = require("../schemas/orgSettings");

/** @param {object} user @param {string} method @param {string} path @param {object} body @returns {object} Supertest request. */
function call(user, method, path, body) {
  var req = request(app)
    [method](path)
    .set("Authorization", "Bearer " + user.token);
  return body ? req.send(body) : req;
}

test("workshop calendars preserve identity, escape text and cancel revisions", function calendarInvite(t) {
  var calendar = require("../utils/calendar");
  var previousWebsite = process.env.ORG_WEBSITE_URL;
  process.env.ORG_WEBSITE_URL = "https://events.example.org";
  t.after(function restoreWebsite() {
    if (previousWebsite === undefined) delete process.env.ORG_WEBSITE_URL;
    else process.env.ORG_WEBSITE_URL = previousWebsite;
  });
  var item = {
    _id: "123",
    title: "Build, learn; together",
    location: "Room A",
    description: "Line one\nLine two",
    startsAt: new Date("2026-10-24T12:00:00Z"),
    endsAt: new Date("2026-10-24T13:00:00Z"),
    sequence: 2,
  };
  var invite = calendar.buildWorkshopIcs(item, "PUBLISH");
  assert.ok(invite.includes("UID:workshop-123@events.example.org\r\n"));
  assert.ok(invite.includes("SUMMARY:Build\\, learn\\; together"));
  assert.ok(invite.includes("DESCRIPTION:Line one\\nLine two"));
  item.sequence = 3;
  var cancellation = calendar.buildWorkshopIcs(item, "CANCEL");
  assert.match(cancellation, /METHOD:CANCEL/);
  assert.match(cancellation, /STATUS:CANCELLED/);
  assert.match(cancellation, /SEQUENCE:3/);
  assert.ok(cancellation.includes("UID:workshop-123@events.example.org\r\n"));
});

test("workshops: CRUD, permissions, atomic capacity and calendar lifecycle", async function workshops(t) {
  await db.connect();
  t.after(async function close() {
    await db.closeDatabase();
  });
  await db.clearDatabase();
  await Template.seedDefaults();
  var mail = mailMock.mockTransport(t);
  var admin = await fixtures.createUser({ role: "admin" });
  var pending = await fixtures.createUser();
  var round = await Round.create({ name: "General" });
  var users = [];
  for (var i = 0; i < 10; i += 1) {
    var user = await fixtures.createUser();
    await Application.create({
      applicant: user.user._id,
      round: round._id,
      name: "Attendee",
      status: "accepted",
    });
    users.push(user);
  }
  var data = {
    title: "Build together",
    host: "Speaker",
    startsAt: "2026-10-24T12:00:00Z",
    endsAt: "2026-10-24T13:00:00Z",
    location: "Room A",
    capacity: 3,
    published: true,
  };
  var id;
  await t.test(
    "admin CRUD validates dates, capacities and flags",
    async function () {
      assert.equal(
        (await call(pending, "post", "/api/admin/workshops", data)).status,
        403,
      );
      for (var invalid of [
        { title: "" },
        { endsAt: data.startsAt },
        { capacity: -1 },
        { capacity: 1.5 },
        { published: "true" },
        { startsAt: "invalid" },
      ]) {
        assert.equal(
          (
            await call(
              admin,
              "post",
              "/api/admin/workshops",
              Object.assign({}, data, invalid),
            )
          ).status,
          400,
        );
      }
      var created = await call(admin, "post", "/api/admin/workshops", data);
      assert.equal(created.status, 201);
      id = created.body.workshop._id;
      assert.equal(
        (await call(admin, "get", "/api/admin/workshops")).body.workshops
          .length,
        1,
      );
      assert.equal(
        (
          await call(admin, "patch", "/api/admin/workshops/invalid", {
            title: "Updated",
          })
        ).status,
        404,
      );
      var draft = await call(
        admin,
        "post",
        "/api/admin/workshops",
        Object.assign({}, data, { published: false }),
      );
      assert.equal(
        (await call(users[0], "get", "/api/workshops")).body.workshops.length,
        1,
      );
      assert.equal(
        (
          await call(
            users[0],
            "post",
            "/api/workshops/" + draft.body.workshop._id + "/signup",
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await call(
            admin,
            "delete",
            "/api/admin/workshops/" + draft.body.workshop._id,
          )
        ).status,
        200,
      );
      assert.equal(await Workshop.findById(draft.body.workshop._id), null);
    },
  );
  await t.test(
    "only accepted applicants can browse or sign up",
    async function () {
      assert.equal((await request(app).get("/api/workshops")).status, 401);
      for (var status of ["pending", "waitlisted", "rejected"]) {
        await Application.findOneAndUpdate(
          { applicant: pending.user._id },
          { round: round._id, name: "Pending", status: status },
          { upsert: true },
        );
        assert.equal(
          (await call(pending, "get", "/api/workshops")).status,
          403,
        );
        assert.equal(
          (await call(pending, "post", "/api/workshops/" + id + "/signup"))
            .status,
          403,
        );
      }
    },
  );
  var winners;
  await t.test(
    "ten parallel signups fill exactly three seats",
    async function () {
      var responses = await Promise.all(
        users.map(function sign(user) {
          return call(user, "post", "/api/workshops/" + id + "/signup", {
            user: pending.user._id,
          });
        }),
      );
      assert.equal(
        responses.filter(function success(res) {
          return res.status === 201;
        }).length,
        3,
      );
      assert.equal(
        responses.filter(function full(res) {
          return res.status === 409;
        }).length,
        7,
      );
      assert.equal((await Workshop.findById(id)).signupCount, 3);
      assert.equal(await Signup.countDocuments({ workshop: id }), 3);
      assert.equal(await Signup.countDocuments({ user: pending.user._id }), 0);
      winners = users.filter(function won(_user, index) {
        return responses[index].status === 201;
      });
    },
  );
  await t.test(
    "duplicate signup is a no-op and cancellation frees a seat",
    async function () {
      var count = mail.calls.length;
      assert.equal(
        (await call(winners[0], "post", "/api/workshops/" + id + "/signup"))
          .status,
        200,
      );
      assert.equal((await Workshop.findById(id)).signupCount, 3);
      assert.equal(mail.calls.length, count);
      assert.equal(
        (await call(winners[0], "delete", "/api/workshops/" + id + "/signup"))
          .status,
        200,
      );
      assert.equal((await Workshop.findById(id)).signupCount, 2);
      assert.match(mail.calls.at(-1).icalEvent.content, /METHOD:CANCEL/);
      await call(winners[0], "delete", "/api/workshops/" + id + "/signup");
      assert.equal((await Workshop.findById(id)).signupCount, 2);
      assert.equal(
        (await call(winners[0], "post", "/api/workshops/" + id + "/signup"))
          .status,
        201,
      );
    },
  );
  await t.test(
    "parallel duplicates roll back their reserved seats",
    async function () {
      var other = await Workshop.create(
        Object.assign({}, data, { capacity: 0 }),
      );
      var responses = await Promise.all(
        Array.from({ length: 10 }, function sign() {
          return call(
            users[0],
            "post",
            "/api/workshops/" + other._id + "/signup",
          );
        }),
      );
      responses.forEach(function success(res) {
        assert.ok(res.status === 200 || res.status === 201);
      });
      assert.equal(await Signup.countDocuments({ workshop: other._id }), 1);
      assert.equal((await Workshop.findById(other._id)).signupCount, 1);
      await call(users[0], "delete", "/api/workshops/" + other._id + "/signup");
      await Workshop.deleteOne({ _id: other._id });
    },
  );
  await t.test(
    "capacity edits cannot go below occupied seats",
    async function () {
      assert.equal(
        (
          await call(admin, "patch", "/api/admin/workshops/" + id, {
            capacity: 2,
          })
        ).status,
        409,
      );
      assert.equal((await Workshop.findById(id)).capacity, 3);
    },
  );
  await t.test("overlap warns and mine is sorted", async function () {
    var other = await Workshop.create(
      Object.assign({}, data, { title: "Another workshop", capacity: 0 }),
    );
    var res = await call(
      winners[0],
      "post",
      "/api/workshops/" + other._id + "/signup",
    );
    assert.equal(res.status, 201);
    assert.match(res.body.warning, /overlaps/);
    var mine = await call(winners[0], "get", "/api/workshops/mine");
    assert.equal(mine.body.workshops.length, 2);
    assert.ok(
      new Date(mine.body.workshops[0].startsAt) <=
        new Date(mine.body.workshops[1].startsAt),
    );
  });
  await t.test(
    "changes and soft cancellation use the same UID and increasing sequence",
    async function () {
      var original = mail.calls.find(function invite(item) {
        return (
          item.icalEvent &&
          item.icalEvent.content.includes("workshop-" + id + "@")
        );
      }).icalEvent.content;
      var uid = original.match(/UID:([^\r]+)/)[1];
      var previous = Number(original.match(/SEQUENCE:(\d+)/)[1]);
      var count = mail.calls.length;
      var res = await call(admin, "patch", "/api/admin/workshops/" + id, {
        startsAt: "2026-10-24T11:00:00Z",
        location: "Room B",
      });
      assert.equal(res.status, 200);
      // Notifications go out in the background after the response.
      await waitFor(function () {
        return mail.calls.length - count >= 3;
      });
      assert.equal(mail.calls.length - count, 3);
      var changed = mail.calls.at(-1).icalEvent.content;
      assert.ok(changed.includes("UID:" + uid));
      assert.ok(Number(changed.match(/SEQUENCE:(\d+)/)[1]) > previous);
      previous = Number(changed.match(/SEQUENCE:(\d+)/)[1]);
      count = mail.calls.length;
      assert.equal(
        (await call(admin, "delete", "/api/admin/workshops/" + id)).status,
        200,
      );
      assert.equal((await Workshop.findById(id)).cancelled, true);
      await waitFor(function () {
        return mail.calls.length - count >= 3;
      });
      assert.equal(mail.calls.length - count, 3);
      mail.calls.slice(count).forEach(function cancelled(item) {
        assert.equal(item.icalEvent.method, "CANCEL");
        assert.match(item.icalEvent.content, /METHOD:CANCEL/);
        assert.ok(item.icalEvent.content.includes("UID:" + uid));
        assert.ok(
          Number(item.icalEvent.content.match(/SEQUENCE:(\d+)/)[1]) > previous,
        );
      });
      assert.equal(
        (await call(winners[0], "post", "/api/workshops/" + id + "/signup"))
          .status,
        404,
      );
    },
  );
  await t.test(
    "module off returns 404 on every workshop route",
    async function () {
      await Settings.findOneAndUpdate(
        { key: "default" },
        { $set: { "features.workshops": false } },
        { upsert: true },
      );
      for (var route of [
        ["get", "/api/workshops"],
        ["get", "/api/workshops/mine"],
        ["post", "/api/workshops/" + id + "/signup"],
        ["delete", "/api/workshops/" + id + "/signup"],
        ["get", "/api/admin/workshops"],
        ["post", "/api/admin/workshops"],
        ["patch", "/api/admin/workshops/" + id],
        ["delete", "/api/admin/workshops/" + id],
      ]) {
        assert.equal((await call(admin, route[0], route[1], data)).status, 404);
      }
    },
  );
});
