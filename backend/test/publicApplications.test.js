"use strict";

// This file makes more public-apply and auth calls than the default rate
// limit (20 per window) allows; the limiter itself is covered elsewhere.
process.env.AUTH_RATE_LIMIT_MAX = "500";
// Resume uploads are stubbed below, but the "is storage configured" check
// still has to pass for a submission with a file.
process.env.AZURE_STORAGE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=" +
  Buffer.alloc(64, 7).toString("base64") +
  ";EndpointSuffix=core.windows.net";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var azureBlob = require("../utils/azureBlob");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var OrgSettings = require("../schemas/orgSettings");
var User = require("../schemas/user");

/**
 * Fresh database with the built-in email templates and an open round.
 * @param {object} [options]
 * @param {boolean} [options.publicApplications=true] - The admin setting.
 * @param {Array<object>} [options.formConfig] - The round's custom questions.
 * @returns {Promise<object>} The open ApplicationRound.
 */
async function reset(options) {
  var opts = options || {};
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
  await OrgSettings.create({ key: "default", publicApplications: opts.publicApplications !== false });
  return ApplicationRound.create({ name: "General", isOpen: true, formConfig: opts.formConfig || [] });
}

/**
 * Submit the no-account application form.
 * @param {object} fields - Form fields (email, name, ...); objects are JSON-encoded.
 * @param {Buffer} [resume] - Optional resume file contents.
 * @returns {Promise<object>} The supertest response.
 */
function applyPublic(fields, resume) {
  var req = request(app).post("/api/applications/public");
  Object.keys(fields).forEach(function (key) {
    var value = fields[key];
    req = req.field(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  });
  if (resume) {
    req = req.attach("resume", resume, { filename: "cv.pdf", contentType: "application/pdf" });
  }
  return req;
}

/**
 * Pull the raw token out of a password link in an email body.
 * @param {string} text - Email text.
 * @returns {string|null}
 */
function tokenFrom(text) {
  var match = /reset-password\?token=([0-9a-f]+)/.exec(text || "");
  return match ? match[1] : null;
}

test("applying without an account", async function publicApplications(t) {
  await db.connect();

  await t.test("is off by default: the public endpoints 404 and meta config says so", async function () {
    await reset({ publicApplications: false });

    var round = await request(app).get("/api/applications/public/round");
    assert.equal(round.status, 404);

    var submit = await applyPublic({ email: "ada@example.com", name: "Ada" });
    assert.equal(submit.status, 404);
    assert.equal(await User.countDocuments({}), 0);

    var config = await request(app).get("/api/meta/config");
    assert.equal(config.body.publicApplications, false);
  });

  await t.test("an admin can switch it on, and meta config then reports it", async function () {
    await reset({ publicApplications: false });
    var admin = await fixtures.createUser({ role: "admin" });
    var moderator = await fixtures.createUser({ role: "moderator" });

    var denied = await request(app)
      .patch("/api/admin/settings")
      .set("Authorization", "Bearer " + moderator.token)
      .send({ publicApplications: true });
    assert.equal(denied.status, 403);

    var res = await request(app)
      .patch("/api/admin/settings")
      .set("Authorization", "Bearer " + admin.token)
      .send({ publicApplications: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.publicApplications, true);

    var config = await request(app).get("/api/meta/config");
    assert.equal(config.body.publicApplications, true);
  });

  await t.test("serves the open round's form", async function () {
    await reset({ formConfig: [{ key: "year", label: "Graduation year", type: "select", options: ["2027", "2028"] }] });

    var res = await request(app).get("/api/applications/public/round");
    assert.equal(res.status, 200);
    assert.equal(res.body.round.name, "General");
    assert.equal(res.body.round.formConfig[0].key, "year");
  });

  await t.test("creates a passwordless applicant and a pending application, and emails a receipt", async function (t2) {
    await reset({ formConfig: [{ key: "year", label: "Graduation year", type: "select", required: true, options: ["2027", "2028"] }] });
    var mail = mailMock.mockTransport(t2);

    var res = await applyPublic({ email: "  Ada@Example.com ", name: "Ada Lovelace", answers: { year: "2027" } });
    assert.equal(res.status, 201);
    assert.equal(res.body.application.status, "pending");

    var user = await User.findOne({ email: "ada@example.com" });
    assert.ok(user, "user created with the normalized email");
    assert.equal(user.passwordHash, undefined);
    assert.equal(user.role, "applicant");

    var application = await Application.findOne({ applicant: user._id });
    assert.equal(application.name, "Ada Lovelace");
    assert.deepEqual(application.answers, { year: "2027" });

    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.equal(mail.calls[0].to, "ada@example.com");
  });

  await t.test("validates the email, the name and required questions", async function () {
    await reset({ formConfig: [{ key: "year", label: "Graduation year", type: "text", required: true }] });

    assert.equal((await applyPublic({ email: "not-an-email", name: "Ada", answers: { year: "1" } })).status, 400);
    assert.equal((await applyPublic({ email: "ada@example.com", name: "  ", answers: { year: "1" } })).status, 400);
    var missing = await applyPublic({ email: "ada@example.com", name: "Ada" });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /Graduation year is required/);
    assert.equal(await User.countDocuments({}), 0, "nothing created for a rejected submission");
  });

  await t.test("never overwrites an existing application: same email again is a 409", async function () {
    await reset();
    assert.equal((await applyPublic({ email: "ada@example.com", name: "Ada", phone: "111" })).status, 201);

    var again = await applyPublic({ email: "ada@example.com", name: "Someone Else", phone: "999" });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "ALREADY_APPLIED");

    var applications = await Application.find({});
    assert.equal(applications.length, 1);
    assert.equal(applications[0].name, "Ada");
    assert.equal(applications[0].phone, "111");
  });

  await t.test("an email that already has a real account must log in to apply", async function () {
    await reset();
    await fixtures.createUser({ email: "grace@example.com", passwordHash: await User.hashPassword("hunter22") });

    var res = await applyPublic({ email: "grace@example.com", name: "Grace" });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "ACCOUNT_EXISTS");
    assert.equal(await Application.countDocuments({}), 0);
  });

  await t.test("a passwordless account can't log in, whatever password is tried", async function () {
    await reset();
    await applyPublic({ email: "ada@example.com", name: "Ada" });

    var attempts = ["", " ", "password", "undefined", "null"];
    for (var i = 0; i < attempts.length; i++) {
      var res = await request(app).post("/api/auth/login").send({ email: "ada@example.com", password: attempts[i] });
      assert.notEqual(res.status, 200, "logged in with " + JSON.stringify(attempts[i]));
      assert.equal(res.body.token, undefined);
    }
  });

  await t.test("registering can't claim a passwordless account", async function () {
    await reset();
    await applyPublic({ email: "ada@example.com", name: "Ada" });

    var res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Mallory", email: "ada@example.com", password: "attacker-pass" });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Forgot password/);

    var user = await User.findOne({ email: "ada@example.com" });
    assert.equal(user.passwordHash, undefined);
    assert.equal(user.name, "Ada");
  });

  await t.test("accepting emails a 7-day setup link that sets the first password", async function (t2) {
    await reset();
    await applyPublic({ email: "ada@example.com", name: "Ada" });
    var moderator = await fixtures.createUser({ role: "moderator" });
    var application = await Application.findOne({});
    var mail = mailMock.mockTransport(t2);

    var decided = await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + moderator.token)
      .send({ decision: "accepted" });
    assert.equal(decided.status, 200);

    await waitFor(function () {
      return mail.calls.length >= 2;
    });
    var setup = mail.calls.find(function (call) {
      return /Set up your/.test(call.subject);
    });
    assert.ok(setup, "account setup email sent");
    assert.equal(setup.to, "ada@example.com");
    assert.match(setup.text, /reset-password\?token=[0-9a-f]+&setup=1/);

    var user = await User.findOne({ email: "ada@example.com" });
    var daysLeft = (user.resetPasswordExpires.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    assert.ok(daysLeft > 6.9 && daysLeft <= 7, "link lasts 7 days");

    var set = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: tokenFrom(setup.text), password: "a-new-password" });
    assert.equal(set.status, 200);

    var login = await request(app).post("/api/auth/login").send({ email: "ada@example.com", password: "a-new-password" });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
  });

  await t.test("accepting someone who already has a password sends no setup email", async function (t2) {
    await reset();
    var applicant = await fixtures.createUser({ passwordHash: await User.hashPassword("hunter22") });
    var round = await ApplicationRound.findOne({});
    var application = await Application.create({ applicant: applicant.user._id, round: round._id, status: "pending" });
    var moderator = await fixtures.createUser({ role: "moderator" });
    var mail = mailMock.mockTransport(t2);

    await request(app)
      .patch("/api/admin/applications/" + application._id)
      .set("Authorization", "Bearer " + moderator.token)
      .send({ decision: "accepted" });
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    await new Promise(function (resolve) {
      setTimeout(resolve, 100);
    });
    assert.equal(
      mail.calls.filter(function (call) {
        return /Set up your/.test(call.subject);
      }).length,
      0
    );
  });

  // ---- Resume upload questions ---------------------------------------------

  await t.test("a required resume question needs a file; with one, the resume is stored privately", async function (t2) {
    await reset({ formConfig: [{ key: "resume", label: "Resume", type: "resume", required: true }] });
    t2.mock.method(azureBlob, "uploadResume", function fakeUpload() {
      return Promise.resolve("resumes/fake.pdf");
    });

    var without = await applyPublic({ email: "ada@example.com", name: "Ada", answers: { resume: "https://evil.example/cv" } });
    assert.equal(without.status, 400, "a typed answer doesn't count as a resume");
    assert.match(without.body.error, /Resume is required/);

    var withFile = await applyPublic({ email: "ada@example.com", name: "Ada" }, Buffer.from("%PDF-1.4"));
    assert.equal(withFile.status, 201);
    assert.equal(withFile.body.application.hasResume, true);

    var stored = await Application.findOne({});
    assert.equal(stored.resumeBlobName, "resumes/fake.pdf");
    assert.equal(stored.answers.resume, undefined, "nothing stored in answers for the file question");
  });

  await t.test("logged-in applicants satisfy a required resume question with an earlier upload", async function (t2) {
    await reset({ formConfig: [{ key: "resume", label: "Resume", type: "resume", required: true }] });
    var applicant = await fixtures.createUser({ role: "applicant" });
    var round = await ApplicationRound.findOne({});
    await Application.create({ applicant: applicant.user._id, round: round._id, status: "draft", resumeBlobName: "resumes/earlier.pdf" });
    mailMock.mockTransport(t2);

    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Ada")
      .field("status", "pending");
    assert.equal(res.status, 200);
    assert.equal(res.body.application.hasResume, true);
  });

  await t.test("the form builder accepts one resume question but not two", async function () {
    await reset();
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.findOne({});

    var one = await request(app)
      .patch("/api/admin/rounds/" + round._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ formConfig: [{ key: "cv", label: "Resume", type: "resume", required: false }] });
    assert.equal(one.status, 200);

    var two = await request(app)
      .patch("/api/admin/rounds/" + round._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({
        formConfig: [
          { key: "cv", label: "Resume", type: "resume" },
          { key: "cv2", label: "Another resume", type: "resume" },
        ],
      });
    assert.equal(two.status, 400);
    assert.match(two.body.error, /only one resume/);
  });

  await db.closeDatabase();
});
