"use strict";

// Staff corrections of submitted applications:
// PATCH /api/admin/applications/:id/details.

require("./helpers/testEnv");
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var User = require("../schemas/user");

var FORM = [
  { key: "why", label: "Why do you want to come?", type: "textarea", required: true },
  { key: "track", label: "Track", type: "select", required: true, options: ["Hardware", "Software"] },
  {
    key: "languages",
    label: "Languages",
    type: "multiselect",
    required: false,
    options: ["JavaScript", "Python", "C"],
    allowOther: true,
  },
  { key: "portfolio", label: "Portfolio", type: "text", required: false },
  { key: "teamSize", label: "Team size", type: "number", required: false },
  { key: "mlhCoc", label: "I agree to the code of conduct", type: "checkbox", required: true },
  { key: "resume", label: "Resume", type: "resume", required: false },
];

function auth(token) {
  return "Bearer " + token;
}

test("staff can correct submitted applications", async function suite(t) {
  await db.connect();
  t.after(async function close() {
    await db.closeDatabase();
  });
  await db.clearDatabase();

  var admin = await fixtures.createUser({ role: "admin", name: "Ada Admin" });
  var moderator = await fixtures.createUser({ role: "moderator", name: "Mo Moderator" });
  var judge = await fixtures.createUser({ role: "judge" });
  var other = await fixtures.createUser({ email: "taken@example.com" });
  var applicant = await fixtures.createUser({ name: "Trisha Typo", email: "trisha@umass,edu.example.com" });
  var round = await ApplicationRound.create({
    name: "General",
    isOpen: true,
    formConfig: FORM,
    profileFields: { required: ["university"] },
  });
  var application = await Application.create({
    applicant: applicant.user._id,
    round: round._id,
    name: "Trisha Tpyo",
    university: "Univ of Masachusetts",
    status: "accepted",
    flagged: true,
    flagReasons: ["Check the school"],
    socials: { github: "https://github.com/trisha", website: "https://old.example.com" },
    answers: { why: "Learning", track: "Software", languages: ["Python"], mlhCoc: true, legacy: "kept" },
  });
  var url = "/api/admin/applications/" + application._id + "/details";

  await t.test("edits standard fields and records who did it", async function standard() {
    var res = await request(app)
      .patch(url)
      .set("Authorization", auth(admin.token))
      .send({
        fields: {
          name: "  Trisha Typo ",
          university: "University of Massachusetts Amherst",
          age: "21",
          tshirtSize: "M",
          socials: { github: "https://github.com/trisha-t" },
          programmingSkills: ["Python", "Python", " Go "],
        },
      });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    var saved = res.body.application;
    assert.equal(saved.name, "Trisha Typo");
    assert.equal(saved.university, "University of Massachusetts Amherst");
    assert.equal(saved.age, 21);
    assert.equal(saved.socials.github, "https://github.com/trisha-t");
    assert.equal(saved.socials.website, "https://old.example.com", "other links are left alone");
    assert.deepEqual(saved.programmingSkills, ["Python", "Go"]);
    assert.deepEqual(res.body.changed.sort(), ["age", "name", "programmingSkills", "socials.github", "tshirtSize", "university"]);
    assert.equal(saved.status, "accepted");
    assert.equal(saved.flagged, true);
    assert.equal(saved.edits.length, 1);
    assert.equal(saved.edits[0].by.name, "Ada Admin");
    assert.ok(saved.edits[0].at);
    assert.ok(saved.edits[0].fields.indexOf("university") !== -1);
  });

  await t.test("a save that changes nothing adds no audit entry", async function noop() {
    var res = await request(app)
      .patch(url)
      .set("Authorization", auth(admin.token))
      .send({ fields: { name: "Trisha Typo" } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.changed, []);
    assert.equal(res.body.application.edits.length, 1);
  });

  await t.test("required fields stay required", async function required() {
    var res = await request(app)
      .patch(url)
      .set("Authorization", auth(admin.token))
      .send({ fields: { university: "  " } });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors["fields.university"]);
    res = await request(app).patch(url).set("Authorization", auth(admin.token)).send({ fields: { name: "" } });
    assert.equal(res.status, 400);
    res = await request(app).patch(url).set("Authorization", auth(admin.token)).send({ fields: { tshirtSize: "Huge" } });
    assert.equal(res.status, 400);
    res = await request(app).patch(url).set("Authorization", auth(admin.token)).send({ fields: { age: "old" } });
    assert.equal(res.status, 400);
  });

  await t.test("edits answers with the round's form rules", async function answers() {
    var res = await request(app)
      .patch(url)
      .set("Authorization", auth(moderator.token))
      .send({ answers: { track: "Hardware", languages: ["C", "JavaScript", "Rust"], portfolio: "https://me.example.com" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    var saved = res.body.application;
    assert.equal(saved.answers.track, "Hardware");
    assert.deepEqual(saved.answers.languages, ["C", "JavaScript", "Rust"]);
    assert.equal(saved.answers.portfolio, "https://me.example.com");
    assert.equal(saved.answers.why, "Learning", "untouched answers stay");
    assert.equal(saved.answers.legacy, "kept", "answers to removed questions are not dropped");
    assert.equal(saved.answers.mlhCoc, true);
    assert.equal(saved.edits.length, 2);
    assert.equal(saved.edits[1].by.name, "Mo Moderator");
    assert.deepEqual(saved.edits[1].fields.sort(), ["answers.languages", "answers.portfolio", "answers.track"]);
  });

  await t.test("bad choices, missing required answers and wrong types are 400", async function badAnswers() {
    var cases = [
      { track: "Biology" },
      { track: "" },
      { why: "" },
      { languages: ["Rust", "Go"] },
      { languages: "not-a-list-of-strings-but-ok" + "x".repeat(400) },
      { teamSize: "four" },
      { mlhCoc: "maybe" },
      { nope: "unknown question" },
      { resume: "https://evil.example.com" },
    ];
    for (var body of cases) {
      var res = await request(app).patch(url).set("Authorization", auth(admin.token)).send({ answers: body });
      assert.equal(res.status, 400, JSON.stringify(body) + " " + JSON.stringify(res.body));
      assert.ok(res.body.errors["answers." + Object.keys(body)[0]], JSON.stringify(res.body));
    }
    var stored = await Application.findById(application._id).lean();
    assert.equal(stored.answers.track, "Hardware");
  });

  await t.test("staff don't have to re-tick consent checkboxes", async function consent() {
    var res = await request(app)
      .patch(url)
      .set("Authorization", auth(admin.token))
      .send({ answers: { why: "Learning and building", mlhCoc: false, teamSize: "3" } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.application.answers.why, "Learning and building");
  });

  await t.test("forbidden fields are refused and change nothing", async function forbidden() {
    var bodies = [
      { status: "rejected" },
      { decision: "rejected" },
      { fields: { status: "rejected" } },
      { fields: { flagged: false } },
      { fields: { applicant: String(other.user._id) } },
      { fields: { round: String(round._id) } },
      { fields: { resumeBlobName: "x" } },
      { fields: { edits: [] } },
      { user: { role: "admin" } },
      { fields: "name" },
    ];
    for (var body of bodies) {
      var res = await request(app).patch(url).set("Authorization", auth(admin.token)).send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    var stored = await Application.findById(application._id).lean();
    assert.equal(stored.status, "accepted");
    assert.equal(stored.flagged, true);
    assert.equal(String(stored.applicant), String(applicant.user._id));
    var account = await User.findById(applicant.user._id).lean();
    assert.equal(account.role, "applicant");
  });

  await t.test("changes the account email, normalized", async function email() {
    await User.updateOne(
      { _id: applicant.user._id },
      {
        $set: {
          emailVerified: true,
          resetPasswordToken: "old-reset",
          resetPasswordExpires: new Date(Date.now() + 60000),
          emailVerificationToken: "old-verify",
        },
      }
    );
    var res = await request(app)
      .patch(url)
      .set("Authorization", auth(admin.token))
      .send({ user: { email: "  Trisha@UMass.edu ", name: "Trisha T." } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.emailChanged, true);
    assert.equal(res.body.application.applicant.email, "trisha@umass.edu");
    assert.equal(res.body.application.applicant.name, "Trisha T.");
    var account = await User.findById(applicant.user._id).lean();
    assert.equal(account.email, "trisha@umass.edu");
    assert.equal(account.emailVerified, true);
    assert.equal(account.resetPasswordToken, undefined);
    assert.equal(account.resetPasswordExpires, undefined);
    assert.equal(account.emailVerificationToken, undefined);
    var last = res.body.application.edits[res.body.application.edits.length - 1];
    assert.deepEqual(last.fields.sort(), ["user.email", "user.name"]);
  });

  await t.test("invalid and duplicate emails are refused", async function badEmail() {
    var res = await request(app)
      .patch(url)
      .set("Authorization", auth(admin.token))
      .send({ user: { email: "trisha@umass,edu" } });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors["user.email"]);
    res = await request(app)
      .patch(url)
      .set("Authorization", auth(admin.token))
      .send({ user: { email: " TAKEN@example.com" }, fields: { name: "Should Not Save" } });
    assert.equal(res.status, 409);
    var stored = await Application.findById(application._id).lean();
    assert.equal(stored.name, "Trisha Typo", "a refused email leaves the application alone");
    var account = await User.findById(applicant.user._id).lean();
    assert.equal(account.email, "trisha@umass.edu");
  });

  await t.test("applicants never see the edit history", async function hidden() {
    var res = await request(app).get("/api/applications/me").set("Authorization", auth(applicant.token));
    assert.equal(res.status, 200);
    assert.ok(res.body.application);
    assert.equal(res.body.application.edits, undefined);
  });

  await t.test("the review drawer gets the history and the round's form", async function detail() {
    var res = await request(app).get("/api/admin/applications/" + application._id).set("Authorization", auth(moderator.token));
    assert.equal(res.status, 200);
    assert.ok(res.body.application.edits.length >= 3);
    assert.equal(res.body.application.edits[0].by.name, "Ada Admin");
    assert.deepEqual(res.body.application.round.profileFields.required, ["university"]);
  });

  await t.test("only moderators and admins may edit", async function guards() {
    var body = { fields: { name: "Hacked" } };
    assert.equal((await request(app).patch(url).send(body)).status, 401);
    assert.equal((await request(app).patch(url).set("Authorization", auth(applicant.token)).send(body)).status, 403);
    assert.equal((await request(app).patch(url).set("Authorization", auth(judge.token)).send(body)).status, 403);
    var stored = await Application.findById(application._id).lean();
    assert.equal(stored.name, "Trisha Typo");
    var missing = await request(app)
      .patch("/api/admin/applications/" + other.user._id + "/details")
      .set("Authorization", auth(admin.token))
      .send(body);
    assert.equal(missing.status, 404);
  });
});
