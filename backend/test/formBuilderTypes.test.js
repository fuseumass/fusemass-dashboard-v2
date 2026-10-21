"use strict";

process.env.AUTH_RATE_LIMIT_MAX = "500";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var app = require("../server");
var formConfig = require("../utils/formConfig");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var OrgSettings = require("../schemas/orgSettings");

var COLORS = { key: "colors", label: "Favorite colors", type: "multiselect", options: ["Red", "Green, light", "Blue"] };

test("form builder: multiselect, 'Other' answers, help text, built-in question settings", async function (t) {
  // ---- Answer validation ----------------------------------------------------

  await t.test("multiselect stores the chosen options as a list", function () {
    var r = formConfig.validateAnswers([COLORS], { colors: ["Blue", "Green, light", "Blue", " "] });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.answers.colors, ["Blue", "Green, light"], "trimmed, deduped, blanks dropped");
  });

  await t.test("multiselect rejects choices that aren't options unless 'Other' is allowed", function () {
    assert.equal(formConfig.validateAnswers([COLORS], { colors: ["Purple"] }).errors.length, 1);

    var withOther = Object.assign({}, COLORS, { allowOther: true });
    var one = formConfig.validateAnswers([withOther], { colors: ["Red", "Purple"] });
    assert.deepEqual(one.errors, []);
    assert.deepEqual(one.answers.colors, ["Red", "Purple"]);

    assert.equal(formConfig.validateAnswers([withOther], { colors: ["Purple", "Teal"] }).errors.length, 1, "only one Other");
    var tooLong = "x".repeat(formConfig.OTHER_MAX_LENGTH + 1);
    assert.equal(formConfig.validateAnswers([withOther], { colors: [tooLong] }).errors.length, 1);
  });

  await t.test("multiselect: required needs at least one choice; non-lists are rejected", function () {
    var required = Object.assign({}, COLORS, { required: true });
    assert.match(formConfig.validateAnswers([required], { colors: [] }).errors[0], /is required/);
    assert.match(formConfig.validateAnswers([required], { colors: [{ $gt: "" }] }).errors[0], /list of choices/);
    assert.match(formConfig.validateAnswers([required], { colors: { 0: "Red" } }).errors[0], /list of choices/);
  });

  await t.test("select accepts a free-text 'Other' only when allowed", function () {
    var country = { key: "country", label: "Country", type: "select", options: ["Canada", "Mexico"] };
    assert.equal(formConfig.validateAnswers([country], { country: "Peru" }).errors.length, 1);
    var open = Object.assign({}, country, { allowOther: true });
    assert.deepEqual(formConfig.validateAnswers([open], { country: "Peru" }).answers, { country: "Peru" });
    assert.equal(formConfig.validateAnswers([open], { country: ["Peru"] }).errors.length, 1, "an array isn't a select answer");
  });

  // ---- Config shape ----------------------------------------------------------

  await t.test("config shape: allowOther must be boolean, description a string", function () {
    var bad = formConfig.validateFormConfigShape([
      { key: "a", label: "A", type: "select", allowOther: "yes" },
      { key: "b", label: "B", type: "text", description: 5 },
      { key: "c", label: "C", type: "multiselect", options: ["x"], allowOther: true, description: "Pick some." },
    ]);
    assert.equal(bad.errors.length, 2);
    assert.match(bad.errors.join(" "), /allowOther must be a boolean/);
    assert.match(bad.errors.join(" "), /description must be a string/);
  });

  await t.test("profileFields shape: known required keys, options only for education/gender", function () {
    assert.deepEqual(
      formConfig.validateProfileFieldsShape({ required: ["phone", "age"], options: { gender: ["Male", "Female"] } }).errors,
      []
    );
    assert.equal(formConfig.validateProfileFieldsShape({ required: ["email"] }).errors.length, 1);
    assert.equal(formConfig.validateProfileFieldsShape({ options: { major: ["CS"] } }).errors.length, 1);
    assert.equal(formConfig.validateProfileFieldsShape({ options: { gender: [] } }).errors.length, 1);
    assert.equal(formConfig.validateProfileFieldsShape([]).errors.length, 1);
  });

  await t.test("validateProfile reports each missing required built-in", function () {
    var settings = { required: ["phone", "age", "programmingSkills"] };
    var errors = formConfig.validateProfile(settings, { phone: " ", age: NaN, programmingSkills: [] });
    assert.deepEqual(errors, ["Phone is required.", "Age is required.", "Programming skills is required."]);
    assert.deepEqual(formConfig.validateProfile(settings, { phone: "1", age: 20, programmingSkills: ["Go"] }), []);
    assert.deepEqual(formConfig.validateProfile({}, {}), []);
  });

  // ---- Through the API --------------------------------------------------------

  await db.connect();

  await t.test("admins can save built-in question settings on a round; bad ones are refused", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.create({ name: "R", isOpen: true });

    var ok = await request(app)
      .patch("/api/admin/rounds/" + round._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ profileFields: { required: ["phone"], options: { education: ["Undergraduate Student", "Graduate Student"] } } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.round.profileFields.required, ["phone"]);

    var bad = await request(app)
      .patch("/api/admin/rounds/" + round._id)
      .set("Authorization", "Bearer " + admin.token)
      .send({ profileFields: { required: ["passwordHash"] } });
    assert.equal(bad.status, 400);
  });

  await t.test("a submission must fill required built-ins; a draft may skip them", async function (t2) {
    await db.clearDatabase();
    await EmailTemplate.seedDefaults();
    mailMock.mockTransport(t2);
    await ApplicationRound.create({
      name: "R",
      isOpen: true,
      profileFields: { required: ["phone", "university"] },
      formConfig: [Object.assign({}, COLORS, { required: true })],
    });
    var applicant = await fixtures.createUser({ role: "applicant" });

    var submit = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Ada")
      .field("status", "pending")
      .field("answers", JSON.stringify({ colors: ["Red"] }));
    assert.equal(submit.status, 400);
    assert.match(submit.body.error, /Phone is required\. University \/ School is required\./);

    var draft = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Ada")
      .field("status", "draft");
    assert.equal(draft.status, 200);

    var full = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Ada")
      .field("phone", "4135550100")
      .field("university", "UMass Amherst")
      .field("status", "pending")
      .field("answers", JSON.stringify({ colors: ["Red", "Blue"] }));
    assert.equal(full.status, 200);
    assert.deepEqual(full.body.application.answers.colors, ["Red", "Blue"]);
  });

  await t.test("applying without an account enforces required built-ins too", async function (t2) {
    await db.clearDatabase();
    await EmailTemplate.seedDefaults();
    mailMock.mockTransport(t2);
    await OrgSettings.create({ key: "default", publicApplications: true });
    await ApplicationRound.create({ name: "R", isOpen: true, profileFields: { required: ["age"] } });

    var res = await request(app).post("/api/applications/public").field("email", "ada@example.com").field("name", "Ada");
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Age is required/);

    var ok = await request(app)
      .post("/api/applications/public")
      .field("email", "ada@example.com")
      .field("name", "Ada")
      .field("age", "20");
    assert.equal(ok.status, 201);
  });

  await db.closeDatabase();
});
