"use strict";

require("./helpers/testEnv");
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var express = require("express");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var app = require("../server");
var User = require("../schemas/user");
var JudgeProfile = require("../schemas/judgeProfile");
var EmailTemplate = require("../schemas/emailTemplate");
var EmailLog = require("../schemas/emailLog");
var OrgSettings = require("../schemas/orgSettings");
var parseToken = require("../utils/parseToken");
var passwordToken = require("../utils/passwordToken");
var signToken = require("../utils/signToken");

function auth(token) {
  return "Bearer " + token;
}
function inviteToken(mail) {
  var match = mail.text.match(/\/judge\/accept\?token=([a-f0-9]{64})/);
  assert.ok(match, "email has the invite URL");
  return match[1];
}

test("CSV preview handles quoted names, invalid rows and duplicates without side effects", function csvPreview(t) {
  var controller = require("../controllers/judgeController");
  t.mock.method(
    require("../utils/mailer"),
    "sendTemplateEmail",
    function unexpectedMail() {
      assert.fail("Preview sent email");
    },
  );
  t.mock.method(User, "create", function unexpectedWrite() {
    assert.fail("Preview wrote a user");
  });
  var response;
  var code = 200;
  var res = {
    json: function json(value) {
      response = value;
    },
    status: function status(value) {
      code = value;
      return this;
    },
  };
  controller.preview(
    {
      body: {
        csv: 'name,email,hardware\n"Judge, One",one@example.com,true\nTwo,bad,false\nThree,one@example.com,false\nFour,four@example.com,no',
      },
    },
    res,
  );
  assert.equal(code, 200);
  assert.equal(response.rows[0].name, "Judge, One");
  assert.equal(response.rows[0].hardware, true);
  assert.equal(response.rows[0].error, null);
  assert.ok(
    response.rows.slice(1).every(function invalid(row) {
      return row.error;
    }),
  );
  controller.preview(
    { body: { csv: "email,name,hardware\na@example.com,A,true" } },
    res,
  );
  assert.equal(code, 400);
});

test("judge role, credentials and administration", async function suite(t) {
  await db.connect();
  t.after(async function close() {
    await db.closeDatabase();
  });
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
  var admin = await fixtures.createUser({ role: "admin" });
  var judge = await fixtures.createUser({ role: "judge" });
  var applicant = await fixtures.createUser();

  await t.test(
    "guards check current roles and admins pass isJudge",
    async function guards() {
      var guardApp = express();
      guardApp.use(parseToken);
      [
        "isAuthenticated",
        "isJudge",
        "isAdmin",
        "isModerator",
        "isEmailVerified",
      ].forEach(function route(name) {
        guardApp.get(
          "/" + name,
          require("../utils/" + name),
          function allowed(_req, res) {
            res.sendStatus(204);
          },
        );
      });
      for (var name of [
        "isAuthenticated",
        "isJudge",
        "isAdmin",
        "isModerator",
        "isEmailVerified",
      ]) {
        var res = await request(guardApp)
          .get("/" + name)
          .set("Authorization", auth(judge.token));
        assert.equal(
          res.status,
          ["isAuthenticated", "isJudge", "isEmailVerified"].indexOf(name) !== -1
            ? 204
            : 403,
        );
      }
      assert.equal((await request(guardApp).get("/isJudge")).status, 401);
      assert.equal(
        (
          await request(guardApp)
            .get("/isJudge")
            .set("Authorization", auth(admin.token))
        ).status,
        204,
      );
      for (var path of [
        "/api/admin/users",
        "/api/admin/applications",
        "/api/staff/attendees",
        "/api/applications/me/qr",
      ]) {
        assert.equal(
          (await request(app).get(path).set("Authorization", auth(judge.token)))
            .status,
          403,
          path,
        );
      }
      assert.equal(
        (
          await request(app)
            .post("/api/applications")
            .set("Authorization", auth(judge.token))
            .send({})
        ).status,
        403,
      );
    },
  );

  await t.test(
    "invite creates or promotes, emails once, and redacts outbox",
    async function invites(t2) {
      var mail = mailMock.mockTransport(t2);
      for (var email of ["new-judge@example.com", applicant.user.email]) {
        var res = await request(app)
          .post("/api/admin/judges")
          .set("Authorization", auth(admin.token))
          .send({ name: "Invited Judge", email: email, hardware: true });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.user.role, "judge");
        assert.equal(res.body.user.resetPasswordToken, undefined);
        var profile = await JudgeProfile.findOne({ user: res.body.user._id });
        assert.equal(profile.hardware, true);
        assert.equal(profile.active, true);
        assert.equal(profile.calibrationDone, false);
      }
      assert.equal(mail.calls.length, 2);
      var raw = inviteToken(mail.calls[0]);
      var stored = await User.findOne({ email: "new-judge@example.com" });
      assert.notEqual(stored.resetPasswordToken, raw);
      assert.ok(
        stored.resetPasswordExpires.getTime() - Date.now() > 6 * 86400000,
      );
      var logs = await EmailLog.find({ templateKey: "judge_invite" }).lean();
      assert.equal(logs.length, 2);
      assert.ok(
        logs.every(function redacted(row) {
          return row.redacted;
        }),
      );
      assert.ok(!JSON.stringify(logs).includes(raw));
      assert.ok(
        logs.every(function noRetry(row) {
          return row.maxAttempts === 1 && !row.values;
        }),
      );
      var blocked = await request(app)
        .post("/api/admin/outbox/" + logs[0]._id + "/resend")
        .set("Authorization", auth(admin.token));
      assert.equal(blocked.status, 409);
      blocked = await request(app)
        .post("/api/admin/outbox/bulk")
        .set("Authorization", auth(admin.token))
        .send({
          templateKey: "judge_invite",
          segment: "accepted",
          type: "transactional",
        });
      assert.equal(blocked.status, 400);
      assert.equal(mail.calls.length, 2);
      var me = await request(app)
        .get("/api/auth/me")
        .set("Authorization", auth(applicant.token));
      assert.equal(me.body.user.judgeProfile.hardware, true);
      var accepted = await request(app)
        .post("/api/auth/judge/accept")
        .send({ token: raw, password: "new-password" });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.user.role, "judge");
      assert.equal(
        (
          await request(app)
            .post("/api/auth/judge/accept")
            .send({ token: raw, password: "new-password" })
        ).status,
        400,
      );
      var list = await request(app)
        .get("/api/admin/judges")
        .set("Authorization", auth(admin.token));
      assert.equal(
        list.body.judges.find(function match(row) {
          return row.email === stored.email;
        }).inviteStatus,
        "accepted",
      );
    },
  );

  await t.test(
    "resend rotates the credential, expired and concurrent uses fail",
    async function rotate(t2) {
      var mail = mailMock.mockTransport(t2);
      var user = await User.findOne({ email: "new-judge@example.com" });
      await request(app)
        .post("/api/admin/judges/" + user.id + "/resend")
        .set("Authorization", auth(admin.token));
      var old = inviteToken(mail.calls[0]);
      await request(app)
        .post("/api/admin/judges/" + user.id + "/resend")
        .set("Authorization", auth(admin.token));
      var fresh = inviteToken(mail.calls[1]);
      assert.notEqual(old, fresh);
      assert.equal(
        (
          await request(app)
            .post("/api/auth/judge/accept")
            .send({ token: old, password: "new-password" })
        ).status,
        400,
      );
      await User.updateOne(
        { _id: user._id },
        { $set: { resetPasswordExpires: new Date(0) } },
      );
      assert.equal(
        (
          await request(app)
            .post("/api/auth/judge/accept")
            .send({ token: fresh, password: "new-password" })
        ).status,
        400,
      );
      await request(app)
        .post("/api/admin/judges/" + user.id + "/resend")
        .set("Authorization", auth(admin.token));
      fresh = inviteToken(mail.calls[2]);
      var responses = await Promise.all(
        [1, 2].map(function accept() {
          return request(app)
            .post("/api/auth/judge/accept")
            .send({ token: fresh, password: "new-password" });
        }),
      );
      assert.deepEqual(
        responses
          .map(function code(res) {
            return res.status;
          })
          .sort(),
        [200, 400],
      );
    },
  );

  await t.test(
    "bulk preview validates without writing or sending, confirmation sends",
    async function bulk(t2) {
      var mail = mailMock.mockTransport(t2);
      var invalid =
        "name,email,hardware\nJudge,not-email,true\nJudge,dup@example.com,no\nJudge,dup@example.com,false";
      var before = await User.countDocuments();
      var res = await request(app)
        .post("/api/admin/judges/preview")
        .set("Authorization", auth(admin.token))
        .send({ csv: invalid });
      assert.equal(res.status, 200);
      assert.ok(
        res.body.rows.every(function invalidRow(row) {
          return row.error;
        }),
      );
      assert.equal(mail.calls.length, 0);
      assert.equal(await User.countDocuments(), before);
      var csv =
        'name,email,hardware\n"Judge, One",bulk-one@example.com,true\nJudge Two,bulk-two@example.com,false';
      res = await request(app)
        .post("/api/admin/judges/preview")
        .set("Authorization", auth(admin.token))
        .send({ csv: csv });
      assert.equal(res.body.rows[0].name, "Judge, One");
      assert.equal(mail.calls.length, 0);
      assert.equal(
        (
          await request(app)
            .post("/api/admin/judges/bulk")
            .set("Authorization", auth(admin.token))
            .send({ csv: csv })
        ).status,
        400,
      );
      res = await request(app)
        .post("/api/admin/judges/bulk")
        .set("Authorization", auth(admin.token))
        .send({ csv: csv, confirm: true });
      assert.equal(res.status, 200);
      assert.ok(
        res.body.results.every(function sent(row) {
          return row.sent;
        }),
      );
      assert.equal(mail.calls.length, 2);
    },
  );

  await t.test(
    "demotion immediately blocks judging with the same JWT",
    async function demotion() {
      assert.equal(
        (
          await request(app)
            .get("/api/judging")
            .set("Authorization", auth(judge.token))
        ).status,
        200,
      );
      var raw = await passwordToken.issuePasswordToken(
        judge.user,
        passwordToken.SETUP_TTL_MS,
      );
      var res = await request(app)
        .delete("/api/admin/judges/" + judge.user.id)
        .set("Authorization", auth(admin.token));
      assert.equal(res.status, 200);
      assert.equal(res.body.user.role, "applicant");
      assert.equal(
        (
          await request(app)
            .get("/api/judging")
            .set("Authorization", auth(judge.token))
        ).status,
        403,
      );
      assert.equal(
        (
          await request(app)
            .post("/api/auth/judge/accept")
            .send({ token: raw, password: "new-password" })
        ).status,
        400,
      );
      await User.updateOne(
        { _id: applicant.user._id },
        { $set: { role: "applicant" } },
      );
      var stale = signToken({
        id: applicant.user.id,
        email: applicant.user.email,
        role: "judge",
      });
      assert.equal(
        (
          await request(app)
            .get("/api/judging")
            .set("Authorization", auth(stale))
        ).status,
        403,
      );
    },
  );

  await t.test(
    "Users role changes create profiles and revoke access without replacing JWTs",
    async function usersRole() {
      var account = await fixtures.createUser();
      var path = "/api/admin/users/" + account.user.id + "/role";
      var promoted = await request(app)
        .patch(path)
        .set("Authorization", auth(admin.token))
        .send({ role: "judge" });
      assert.equal(promoted.status, 200);
      assert.ok(
        await JudgeProfile.exists({ user: account.user._id, active: true }),
      );
      assert.equal(
        (
          await request(app)
            .get("/api/judging")
            .set("Authorization", auth(account.token))
        ).status,
        200,
      );
      await request(app)
        .patch(path)
        .set("Authorization", auth(admin.token))
        .send({ role: "applicant" });
      assert.equal(
        (
          await request(app)
            .get("/api/judging")
            .set("Authorization", auth(account.token))
        ).status,
        403,
      );
      assert.ok(
        await JudgeProfile.exists({ user: account.user._id, active: false }),
      );
      var self = await request(app)
        .patch("/api/admin/users/" + admin.user.id + "/role")
        .set("Authorization", auth(admin.token))
        .send({ role: "judge" });
      assert.equal(self.status, 400);
    },
  );

  await t.test(
    "matching Google sign-in consumes the pending judge invitation",
    async function google(t2) {
      var mail = mailMock.mockTransport(t2);
      await request(app)
        .post("/api/admin/judges")
        .set("Authorization", auth(admin.token))
        .send({
          name: "Google Judge",
          email: "google-judge@example.com",
          hardware: false,
        });
      var raw = inviteToken(mail.calls[0]);
      var user = await require("../utils/passport").findOrCreateGoogleUser({
        id: "google-judge-test",
        displayName: "Google Judge",
        emails: [{ value: "google-judge@example.com", verified: true }],
      });
      assert.equal(user.role, "judge");
      assert.equal(user.judgeInvitePending, false);
      assert.equal(user.resetPasswordToken, undefined);
      assert.equal(
        (
          await request(app)
            .post("/api/auth/judge/accept")
            .send({ token: raw, password: "new-password" })
        ).status,
        400,
      );
    },
  );

  await t.test(
    "feature flag gates admin routes, profile and acceptance remain available",
    async function flags() {
      var settings = await OrgSettings.getSingleton();
      settings.features.judging = false;
      await settings.save();
      for (var token of [null, admin.token, applicant.token]) {
        var req = request(app).get("/api/admin/judges");
        if (token) req.set("Authorization", auth(token));
        assert.equal((await req).status, 404);
      }
      assert.equal(
        (
          await request(app)
            .get("/api/auth/me")
            .set("Authorization", auth(admin.token))
        ).status,
        200,
      );
      assert.equal(
        (
          await request(app)
            .get("/api/judging")
            .set("Authorization", auth(admin.token))
        ).status,
        200,
      );
      var user = await User.findOne({ email: "bulk-one@example.com" });
      var raw = await passwordToken.issuePasswordToken(
        user,
        passwordToken.SETUP_TTL_MS,
      );
      assert.equal(
        (
          await request(app)
            .post("/api/auth/judge/accept")
            .send({ token: raw, password: "new-password" })
        ).status,
        200,
      );
    },
  );
});
