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
var Attendance = require("../schemas/workshopAttendance");
var Signup = require("../schemas/workshopSignup");
var Attempt = require("../schemas/workshopAttempt");
var Draw = require("../schemas/raffleDraw");
var User = require("../schemas/user");
var Application = require("../schemas/application");
var Round = require("../schemas/applicationRound");
var Template = require("../schemas/emailTemplate");
var Settings = require("../schemas/orgSettings");
var EmailLog = require("../schemas/emailLog");
var codeFor = require("../utils/workshopCode");

/** @param {object} user @param {string} method @param {string} path @param {object} body @returns {object} Request. */
function call(user, method, path, body) {
  var req = request(app)
    [method](path)
    .set("Authorization", "Bearer " + user.token);
  return body ? req.send(body) : req;
}

test("rotating workshop codes change at period boundaries", function () {
  var session = { attendanceSecret: "test-session", attendancePeriodSec: 30 };
  var now = 1800000000000;
  var current = codeFor(session, now);
  assert.match(current, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
  assert.equal(codeFor(session, now + 29999), current);
  assert.notEqual(codeFor(session, now + 30000), current);
  assert.notEqual(codeFor(session, now - 60000), current);
});

test("workshop attendance and raffle lifecycle", async function (t) {
  await db.connect();
  t.after(async function () {
    await db.closeDatabase();
  });
  await db.clearDatabase();
  await Promise.all([Attendance.init(), Attempt.init(), Draw.init()]);
  await Template.seedDefaults();
  var mail = mailMock.mockTransport(t);
  var previousProxy = app.get("trust proxy");
  app.set("trust proxy", 1);
  t.after(function restoreProxy() {
    app.set("trust proxy", previousProxy);
  });
  var admin = await fixtures.createUser({ role: "admin" });
  var moderator = await fixtures.createUser({ role: "moderator" });
  var organizer = await fixtures.createUser();
  var outsider = await fixtures.createUser();
  var round = await Round.create({ name: "General" });
  var users = [];
  for (var i = 0; i < 25; i += 1) {
    var user = await fixtures.createUser({ checkedIn: true });
    await Application.create({
      applicant: user.user._id,
      round: round._id,
      name: "Attendee",
      status: "accepted",
    });
    users.push(user);
  }
  var workshop = await Workshop.create({
    title: "Workshop",
    startsAt: new Date(Date.now() - 60000),
    endsAt: new Date(Date.now() + 3600000),
    published: true,
    raffleEnabled: true,
    organizers: [organizer.user._id],
  });
  var base = "/api/workshops/" + workshop._id;
  await t.test(
    "managers use current roles and assignments; feature gates precede authorization",
    async function () {
      assert.equal(
        (await call(outsider, "post", base + "/attendance/open")).status,
        403,
      );
      assert.equal(
        (
          await call(organizer, "post", base + "/attendance/open", {
            minutes: 0,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await call(organizer, "post", base + "/attendance/open", {
            minutes: 10,
          })
        ).status,
        200,
      );
      assert.equal(
        (await call(moderator, "post", base + "/attendance/open")).status,
        409,
      );
      assert.equal(
        (
          await call(moderator, "post", base + "/attendance/extend", {
            minutes: 2,
          })
        ).status,
        200,
      );
      var list = await call(organizer, "get", "/api/workshops/manageable");
      assert.equal(list.body.workshops.length, 1);
      assert.ok(!JSON.stringify(list.body).includes("attendanceSecret"));
      await User.updateOne({ _id: moderator.user._id }, { role: "applicant" });
      assert.equal(
        (await call(moderator, "get", base + "/attendance/code")).status,
        403,
      );
      await User.updateOne({ _id: moderator.user._id }, { role: "moderator" });
    },
  );
  await t.test(
    "current and previous accepted, older rejected; callers cannot select another user",
    async function () {
      var session = await Workshop.findById(workshop._id).select(
        "+attendanceSecret",
      );
      var now = Date.now();
      var response = await call(users[0], "post", base + "/attendance", {
        code: codeFor(session, now),
        userId: users[1].user._id,
      });
      assert.equal(response.status, 200);
      assert.equal(
        await Attendance.countDocuments({
          workshop: workshop._id,
          user: users[1].user._id,
        }),
        0,
      );
      assert.equal(
        (
          await call(users[1], "post", base + "/attendance", {
            code: codeFor(session, now - 30000),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(users[2], "post", base + "/attendance", {
            code: codeFor(session, now - 90000),
          })
        ).status,
        400,
      );
      assert.equal(
        (await call(users[0], "post", base + "/attendance", { code: "WRONG" }))
          .body.alreadyHere,
        true,
      );
      var me = await call(users[0], "get", base + "/me");
      assert.equal(me.body.attended, true);
      assert.ok(!JSON.stringify(me.body).includes("attendanceSecret"));
      assert.ok(!JSON.stringify(me.body).includes(users[1].user.email));
      assert.ok(!JSON.stringify(me.body).includes("qrId"));
      assert.ok(
        !JSON.stringify(
          (await call(users[0], "get", "/api/workshops")).body,
        ).includes("attendanceSecret"),
      );
    },
  );
  await t.test(
    "event check-in and open session required; signup not required; staff uses same rule",
    async function () {
      await User.updateOne({ _id: users[3].user._id }, { checkedIn: false });
      var denied = await call(users[3], "post", base + "/attendance", {
        code: "ABCDE",
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error, "Check in at the front desk first");
      assert.equal(
        (
          await call(admin, "post", base + "/attendance/staff", {
            userId: users[3].user._id,
          })
        ).status,
        403,
      );
      await call(admin, "post", base + "/attendance/close");
      assert.equal(
        (await call(users[2], "post", base + "/attendance", { code: "ABCDE" }))
          .status,
        409,
      );
      assert.equal(
        (await call(admin, "get", base + "/attendance/code")).status,
        409,
      );
      assert.equal(
        (
          await call(admin, "post", base + "/attendance/staff", {
            userId: users[2].user._id,
          })
        ).status,
        200,
      );
      var record = await Attendance.findOne({
        workshop: workshop._id,
        user: users[2].user._id,
      });
      assert.equal(record.method, "staff");
      assert.equal(String(record.addedBy), String(admin.user._id));
      assert.equal(
        (
          await call(admin, "post", base + "/attendance/staff", {
            qrId: await User.ensureQrId(users[4].user._id),
          })
        ).status,
        200,
      );
      await Signup.create({ workshop: workshop._id, user: users[0].user._id });
      var stats = await call(admin, "get", base + "/attendance");
      assert.deepEqual(stats.body.counts, {
        signedUp: 1,
        attended: 4,
        walkIns: 3,
      });
      var csv = await call(admin, "get", base + "/attendance.csv");
      assert.equal(csv.status, 200);
      assert.match(csv.text, /Name,Email/);
      await call(admin, "post", base + "/attendance/open");
    },
  );
  await t.test(
    "ten wrong codes lock out a session and per-user attempt limiter answers 429",
    async function () {
      for (var i = 0; i < 10; i += 1) {
        var res = await call(users[5], "post", base + "/attendance", {
          code: "!!!!!",
        });
        assert.equal(res.status, i === 9 ? 429 : 400);
      }
      assert.equal(
        (await Attempt.findOne({ user: users[5].user._id })).wrong,
        10,
      );
      var freshIp = await request(app)
        .post(base + "/attendance")
        .set("Authorization", "Bearer " + users[5].token)
        .set("X-Forwarded-For", "192.0.2.25")
        .send({
          code: codeFor(
            await Workshop.findById(workshop._id).select("+attendanceSecret"),
            Date.now(),
          ),
        });
      assert.equal(freshIp.status, 429);
      assert.match(freshIp.body.error, /staff member/);
      var session = await Workshop.findById(workshop._id).select(
        "+attendanceSecret",
      );
      assert.equal(
        (
          await call(users[5], "post", base + "/attendance", {
            code: codeFor(session, Date.now()),
          })
        ).status,
        429,
      );
      var limited = await Workshop.create({
        title: "Limiter",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 60000),
        published: true,
      });
      for (var j = 0; j < 10; j += 1) {
        assert.equal(
          (
            await call(
              users[7],
              "post",
              "/api/workshops/" + limited._id + "/attendance",
              { code: "ABCDE" },
            )
          ).status,
          409,
        );
      }
      assert.equal(
        (
          await call(
            users[7],
            "post",
            "/api/workshops/" + limited._id + "/attendance",
            { code: "ABCDE" },
          )
        ).status,
        429,
      );
      assert.equal(
        (
          await call(
            users[8],
            "post",
            "/api/workshops/" + limited._id + "/attendance",
            { code: "ABCDE" },
          )
        ).status,
        409,
      );
      // Staff override remains available after a phone is locked out.
      assert.equal(
        (
          await call(admin, "post", base + "/attendance/staff", {
            userId: users[5].user._id,
          })
        ).status,
        200,
      );
    },
  );
  await t.test(
    "draw timing, flag, eligible pool, count cap, claim and exhausted pool",
    async function () {
      assert.equal(
        (
          await call(admin, "post", base + "/raffle/draw", {
            prize: "Kit",
            count: 1,
          })
        ).status,
        409,
      );
      await Workshop.updateOne({ _id: workshop._id }, { raffleEnabled: false });
      assert.equal(
        (
          await call(admin, "post", base + "/raffle/draw", {
            prize: "Kit",
            count: 1,
            early: true,
          })
        ).status,
        409,
      );
      await Workshop.updateOne({ _id: workshop._id }, { raffleEnabled: true });
      await User.updateOne({ _id: users[1].user._id }, { checkedIn: false });
      await Application.updateOne(
        { applicant: users[4].user._id },
        { status: "rejected" },
      );
      var result = await call(admin, "post", base + "/raffle/draw", {
        prize: "Kit",
        count: 999,
        early: true,
      });
      assert.equal(result.status, 201);
      assert.equal(result.body.draw.poolSize, 3);
      assert.equal(result.body.draw.winners.length, 3);
      var ids = result.body.draw.winners.map(function (w) {
        return String(w.user);
      });
      assert.deepEqual(
        new Set(ids),
        new Set(
          [0, 2, 5].map(function (i) {
            return String(users[i].user._id);
          }),
        ),
      );
      var path =
        base + "/raffle/" + result.body.draw._id + "/winners/" + ids[0];
      assert.equal((await call(admin, "post", path + "/claim")).status, 200);
      assert.equal((await call(admin, "post", path + "/redraw")).status, 409);
      var stored = await Draw.findById(result.body.draw._id);
      assert.equal(stored.winners[0].claimed, true);
      assert.ok(stored.winners[0].claimedAt);
      assert.equal(
        (
          await call(admin, "post", base + "/raffle/draw", {
            prize: "Other",
            count: 1,
            early: true,
          })
        ).status,
        409,
      );
      await waitFor(
        function () {
          return mail.calls.length >= 3;
        },
        { timeoutMs: 10000 },
      );
      assert.equal(
        await EmailLog.countDocuments({ templateKey: "raffle_winner" }),
        3,
      );
      assert.match(mail.calls[0].text, /the organizer room/);
    },
  );
  await t.test(
    "redraw excludes no-shows and records parent draw; attendee sees own prize only",
    async function () {
      var original = await Draw.findOne({ workshop: workshop._id });
      var noShow = original.winners[1];
      await call(admin, "post", base + "/attendance/staff", {
        userId: users[6].user._id,
      });
      await Settings.findOneAndUpdate(
        { key: "default" },
        { organizerRoom: "Room S120" },
        { upsert: true },
      );
      var res = await call(
        admin,
        "post",
        base +
          "/raffle/" +
          original._id +
          "/winners/" +
          noShow.user +
          "/redraw",
      );
      assert.equal(res.status, 201);
      assert.equal(res.body.draw.redrawOf, String(original._id));
      assert.equal(
        String(res.body.draw.winners[0].user),
        String(users[6].user._id),
      );
      var me = await call(users[6], "get", base + "/me");
      assert.deepEqual(me.body.wins, [{ prize: "Kit", claimed: false }]);
      assert.equal(me.body.organizerRoom, "Room S120");
      assert.ok(!JSON.stringify(me.body).includes("email"));
      assert.equal((await Draw.findById(original._id)).winners[1].noShow, true);
      assert.equal(
        (await call(admin, "get", "/api/admin/raffles")).body.draws.length,
        2,
      );
    },
  );
  await t.test(
    "twenty parallel draws never repeat a winner",
    async function () {
      var parallel = await Workshop.create({
        title: "Parallel",
        startsAt: new Date(Date.now() - 60000),
        endsAt: new Date(Date.now() - 1000),
        published: true,
        raffleEnabled: true,
      });
      for (var user of users.slice(5))
        await Attendance.create({
          workshop: parallel._id,
          user: user.user._id,
          method: "staff",
          addedBy: admin.user._id,
        });
      var results = await Promise.all(
        Array.from({ length: 20 }, function () {
          return call(
            admin,
            "post",
            "/api/workshops/" + parallel._id + "/raffle/draw",
            { count: 1, prize: "Prize" },
          );
        }),
      );
      results.forEach(function (res) {
        assert.equal(res.status, 201);
      });
      var records = await Draw.find({ workshop: parallel._id }).lean();
      var ids = records.flatMap(function (draw) {
        return draw.winners.map(function (w) {
          return String(w.user);
        });
      });
      assert.equal(ids.length, 20);
      assert.equal(new Set(ids).size, 20);
      await waitFor(
        function () {
          return mail.calls.length >= 24;
        },
        { timeoutMs: 35000 },
      );
    },
  );
  await t.test(
    "every new route is unavailable while module off",
    async function () {
      await Settings.findOneAndUpdate(
        { key: "default" },
        { "features.workshops": false },
        { upsert: true },
      );
      for (var route of [
        ["get", "/api/workshops/manageable"],
        ["get", base + "/me"],
        ["post", base + "/attendance"],
        ["post", base + "/attendance/open"],
        ["post", base + "/attendance/extend"],
        ["post", base + "/attendance/close"],
        ["get", base + "/attendance/code"],
        ["post", base + "/attendance/staff"],
        ["get", base + "/attendance"],
        ["get", base + "/attendance.csv"],
        ["post", base + "/raffle/draw"],
        ["get", base + "/raffle"],
        ["post", base + "/raffle/invalid/winners/invalid/claim"],
        ["post", base + "/raffle/invalid/winners/invalid/redraw"],
        ["get", "/api/admin/raffles"],
      ]) {
        assert.equal(
          (await call(admin, route[0], route[1], { count: 1, prize: "Kit" }))
            .status,
          404,
        );
      }
    },
  );
});
