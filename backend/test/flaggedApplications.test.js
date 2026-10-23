"use strict";

// Public-apply calls below exceed the default auth rate limit (20 per window).
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
var mongoose = require("mongoose");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var files = require("./helpers/resumeFiles");
var app = require("../server");
var azureBlob = require("../utils/azureBlob");
var resumeText = require("../utils/resumeText");
var flags = require("../utils/applicationFlags");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var OrgSettings = require("../schemas/orgSettings");

var DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

// ---- The rules themselves --------------------------------------------------------
// Pure functions, so each rule gets a table that checks BOTH sides of its
// condition. The old dashboard's check had a misplaced `!` and flagged exactly
// the applications it should have passed.

test("B42: rules - phone numbers compare by their last 10 digits", function () {
  ["(413) 555-0100", "413.555.0100", "+1 413 555 0100", "1-413-555-0100", "4135550100"].forEach(function (phone) {
    assert.equal(flags.phoneKey(phone), "4135550100", phone);
  });
  assert.notEqual(flags.phoneKey("413 555 0101"), flags.phoneKey("413 555 0100"));
  ["", "  ", undefined, null, "n/a", "12345", "555-01"].forEach(function (phone) {
    assert.equal(flags.phoneKey(phone), "", JSON.stringify(phone) + " is not a number worth comparing");
  });
});

test("B42: rules - the parts of a name worth looking for", function () {
  assert.deepEqual(flags.nameParts("José Núñez-Smith"), ["jose", "nunez", "smith"]);
  assert.deepEqual(flags.nameParts("  Ada   Lovelace "), ["ada", "lovelace"]);
  assert.deepEqual(flags.nameParts("Li Wu"), [], "two-letter parts turn up in any text");
  assert.deepEqual(flags.nameParts("Li Chen"), ["chen"]);
  assert.deepEqual(flags.nameParts(""), []);
  assert.deepEqual(flags.nameParts(undefined), []);
  assert.equal(flags.lettersOnly("Jon-athan  GRIFFIN\n(413)"), "jonathangriffin");
});

test("B42: rules - resume text: flagged exactly when it is nearly empty or lacks the name", function () {
  var R = flags.REASONS;
  var filler = "built and shipped software with a small team of friends ".repeat(10);
  var name = "Jonathan Griffin-Smith";

  // [description, resume text, applicant name, expected reasons]
  var table = [
    ["no resume at all: nothing to judge", undefined, name, []],
    ["text that couldn't be read: nothing to judge", null, name, []],
    ["a long resume that names the applicant", name + ". " + filler, name, []],
    ["a long resume that never names the applicant", "Someone Else. " + filler, name, [R.resumeMissingName]],
    ["only the surname appears", "J. Smith " + filler, name, []],
    ["name split across lines and spaces", "Jona\nthan   Grif fin " + filler, name, []],
    ["accents on either side", "Jose Nunez " + filler, "José Núñez", []],
    ["different case", "JONATHAN GRIFFIN " + filler, name, []],
    ["no usable name to look for: nothing to judge", filler, "Li Wu", []],
    ["no name given: nothing to judge", filler, "", []],
    ["empty text", "", name, [R.resumeTooShort]],
    ["whitespace and symbols only", " \n\n ----- ", name, [R.resumeTooShort]],
    ["short but names the applicant: still short, and only that", name + " resume", name, [R.resumeTooShort]],
    ["short and without the name: only 'short'", "hello world", name, [R.resumeTooShort]],
  ];
  table.forEach(function (row) {
    assert.deepEqual(flags.resumeProblems(row[1], row[2]), row[3], row[0]);
  });

  // The boundary: 99 letters is short, 100 is not.
  assert.deepEqual(flags.resumeProblems("a".repeat(flags.MIN_RESUME_LETTERS - 1), ""), [R.resumeTooShort]);
  assert.deepEqual(flags.resumeProblems("a".repeat(flags.MIN_RESUME_LETTERS), ""), []);
});

test("B42: rules - combining the automatic reasons", function () {
  var R = flags.REASONS;
  var long = "x".repeat(300) + " Ada Lovelace";
  assert.deepEqual(flags.autoFlagReasons({ name: "Ada Lovelace", resumeText: long }), []);
  assert.deepEqual(flags.autoFlagReasons({ name: "Ada Lovelace" }), []);
  assert.deepEqual(flags.autoFlagReasons({ name: "Ada", duplicatePhone: true }), [R.duplicatePhone]);
  assert.deepEqual(flags.autoFlagReasons({ name: "Ada", duplicateResume: true }), [R.duplicateResume]);
  assert.deepEqual(flags.autoFlagReasons({ name: "Ada", resumeText: "", duplicatePhone: true, duplicateResume: true }), [
    R.resumeTooShort,
    R.duplicatePhone,
    R.duplicateResume,
  ]);
});

test("B42: rules - tidying a moderator's reason", function () {
  assert.equal(flags.cleanReason("  Same\n\tresume   as Bob  "), "Same resume as Bob");
  assert.equal(flags.cleanReason("x".repeat(500)).length, flags.MAX_REASON_LENGTH);
  [undefined, null, 5, {}, ["a"], "", "   "].forEach(function (bad) {
    assert.equal(flags.cleanReason(bad), "", JSON.stringify(bad));
  });
  assert.equal(flags.fileHash(Buffer.from("a")), flags.fileHash(Buffer.from("a")));
  assert.notEqual(flags.fileHash(Buffer.from("a")), flags.fileHash(Buffer.from("b")));
});

// ---- Moderators flagging by hand ---------------------------------------------------

/**
 * A round with a form, one pending application and one user of each role.
 * @returns {Promise<object>}
 */
async function seed() {
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
  var round = await ApplicationRound.create({ name: "General", isOpen: true });
  var applicant = await fixtures.createUser({ role: "applicant", email: "ada@example.com" });
  var moderator = await fixtures.createUser({ role: "moderator", name: "Mo Derator" });
  var admin = await fixtures.createUser({ role: "admin" });
  var application = await Application.create({
    applicant: applicant.user._id,
    round: round._id,
    status: "pending",
    name: "Ada Lovelace",
    phone: "4135550100",
  });
  return { round: round, applicant: applicant, moderator: moderator, admin: admin, application: application };
}

test("B42: moderators flag and unflag applications", async function (t) {
  await db.connect();

  await t.test("flagging records the reason, who flagged it and when", async function () {
    var s = await seed();
    var path = "/api/admin/applications/" + s.application._id + "/flag";

    var res = await request(app).post(path).set(as(s.moderator)).send({ reason: "  Looks like a bot  " });
    assert.equal(res.status, 200);
    assert.equal(res.body.application.flagged, true);
    assert.deepEqual(res.body.application.flagReasons, ["Looks like a bot"]);
    assert.equal(res.body.application.flaggedBy.email, s.moderator.user.email);
    assert.ok(res.body.application.flaggedAt);

    var saved = await Application.findById(s.application._id);
    assert.equal(saved.flagged, true);
    assert.equal(String(saved.flaggedBy), String(s.moderator.user._id));
    assert.equal(saved.status, "pending", "flagging doesn't decide anything");
  });

  await t.test("a second flag adds its reason and takes over 'flagged by'; the same reason isn't repeated", async function () {
    var s = await seed();
    var path = "/api/admin/applications/" + s.application._id + "/flag";
    await request(app).post(path).set(as(s.moderator)).send({ reason: "Fake phone number" });
    await request(app).post(path).set(as(s.moderator)).send({ reason: "Fake phone number" });
    var res = await request(app).post(path).set(as(s.admin)).send({ reason: "Resume is someone else's" });

    assert.deepEqual(res.body.application.flagReasons, ["Fake phone number", "Resume is someone else's"]);
    assert.equal(String((await Application.findById(s.application._id)).flaggedBy), String(s.admin.user._id));
  });

  await t.test("a reason is required, tidied and capped", async function () {
    var s = await seed();
    var path = "/api/admin/applications/" + s.application._id + "/flag";
    for (var body of [{}, { reason: "" }, { reason: "   " }, { reason: 5 }]) {
      var bad = await request(app).post(path).set(as(s.moderator)).send(body);
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
    assert.equal((await Application.findById(s.application._id)).flagged, false);

    var long = await request(app).post(path).set(as(s.moderator)).send({ reason: "y".repeat(1000) });
    assert.equal(long.body.application.flagReasons[0].length, flags.MAX_REASON_LENGTH);
  });

  await t.test("unflagging clears the flag, its reasons and who set it; doing it twice is fine", async function () {
    var s = await seed();
    var path = "/api/admin/applications/" + s.application._id + "/flag";
    await request(app).post(path).set(as(s.moderator)).send({ reason: "Suspicious" });

    var res = await request(app).delete(path).set(as(s.moderator));
    assert.equal(res.status, 200);
    assert.equal(res.body.application.flagged, false);
    assert.deepEqual(res.body.application.flagReasons, []);
    assert.equal(res.body.application.flaggedBy, undefined);

    var saved = await Application.findById(s.application._id).lean();
    assert.equal(saved.flaggedBy, undefined);
    assert.equal(saved.flaggedAt, undefined);
    assert.equal((await request(app).delete(path).set(as(s.moderator))).status, 200);
  });

  await t.test("a decision doesn't change a flag", async function (t2) {
    var s = await seed();
    mailMock.mockTransport(t2);
    await request(app).post("/api/admin/applications/" + s.application._id + "/flag").set(as(s.moderator)).send({ reason: "Check" });
    var res = await request(app)
      .patch("/api/admin/applications/" + s.application._id)
      .set(as(s.moderator))
      .send({ decision: "accepted" });
    assert.equal(res.body.application.status, "accepted");
    assert.equal(res.body.application.flagged, true);
  });

  await t.test("only moderators and admins; unknown and malformed ids are 404", async function () {
    var s = await seed();
    var path = "/api/admin/applications/" + s.application._id + "/flag";
    assert.equal((await request(app).post(path).send({ reason: "x" })).status, 401);
    assert.equal((await request(app).delete(path)).status, 401);
    assert.equal((await request(app).post(path).set(as(s.applicant)).send({ reason: "x" })).status, 403);
    assert.equal((await request(app).delete(path).set(as(s.applicant))).status, 403);
    assert.equal((await Application.findById(s.application._id)).flagged, false);

    var missing = "/api/admin/applications/" + new mongoose.Types.ObjectId() + "/flag";
    assert.equal((await request(app).post(missing).set(as(s.moderator)).send({ reason: "x" })).status, 404);
    assert.equal((await request(app).delete(missing).set(as(s.moderator))).status, 404);
    assert.equal((await request(app).post("/api/admin/applications/nope/flag").set(as(s.moderator)).send({ reason: "x" })).status, 404);
    assert.equal((await request(app).delete("/api/admin/applications/nope/flag").set(as(s.moderator))).status, 404);
  });

  await db.closeDatabase();
});

// ---- The review list and detail ----------------------------------------------------

test("B42: review list filter and count", async function (t) {
  await db.connect();

  /**
   * Three applications in two rounds; two are flagged.
   * @returns {Promise<object>}
   */
  async function seedMany() {
    var s = await seed();
    var other = await ApplicationRound.create({ name: "Late", isOpen: false });
    var second = await fixtures.createUser({ role: "applicant" });
    var third = await fixtures.createUser({ role: "applicant" });
    s.flaggedAccepted = await Application.create({
      applicant: second.user._id,
      round: s.round._id,
      status: "accepted",
      name: "Grace Hopper",
      flagged: true,
      flagReasons: ["Same resume as another applicant"],
    });
    s.flaggedLate = await Application.create({
      applicant: third.user._id,
      round: other._id,
      status: "pending",
      name: "Alan Turing",
      flagged: true,
      flagReasons: ["Fake phone"],
    });
    s.other = other;
    return s;
  }

  await t.test("rows say whether they're flagged but carry no reasons, and the count rides along", async function () {
    var s = await seedMany();
    var res = await request(app).get("/api/admin/applications").set(as(s.moderator));
    assert.equal(res.status, 200);
    assert.equal(res.body.applications.length, 3);
    assert.equal(res.body.flaggedCount, 2);
    res.body.applications.forEach(function (row) {
      assert.equal(typeof row.flagged, "boolean");
      assert.equal(row.flagReasons, undefined, "the list stays slim");
      assert.equal(row.flaggedBy, undefined);
    });
    var byName = {};
    res.body.applications.forEach(function (row) {
      byName[row.name] = row.flagged;
    });
    assert.deepEqual(byName, { "Ada Lovelace": false, "Grace Hopper": true, "Alan Turing": true });
  });

  await t.test("?flagged=true lists only flagged applications", async function () {
    var s = await seedMany();
    for (var query of ["?flagged=true", "?flagged=1"]) {
      var res = await request(app).get("/api/admin/applications" + query).set(as(s.moderator));
      assert.deepEqual(
        res.body.applications.map(function (row) {
          return row.name;
        }).sort(),
        ["Alan Turing", "Grace Hopper"],
        query
      );
      assert.equal(res.body.flaggedCount, 2);
    }
    var all = await request(app).get("/api/admin/applications?flagged=false").set(as(s.moderator));
    assert.equal(all.body.applications.length, 3, "anything but true is no filter");
  });

  await t.test("the count follows the status and round filters; the flagged filter doesn't change it", async function () {
    var s = await seedMany();

    var accepted = await request(app).get("/api/admin/applications?status=accepted").set(as(s.moderator));
    assert.equal(accepted.body.applications.length, 1);
    assert.equal(accepted.body.flaggedCount, 1);

    var pending = await request(app).get("/api/admin/applications?status=pending").set(as(s.moderator));
    assert.equal(pending.body.applications.length, 2);
    assert.equal(pending.body.flaggedCount, 1);

    var round = await request(app).get("/api/admin/applications?round=" + s.round._id).set(as(s.moderator));
    assert.equal(round.body.applications.length, 2);
    assert.equal(round.body.flaggedCount, 1);

    var both = await request(app).get("/api/admin/applications?status=pending&flagged=true").set(as(s.moderator));
    assert.deepEqual(
      both.body.applications.map(function (row) {
        return row.name;
      }),
      ["Alan Turing"]
    );
    assert.equal(both.body.flaggedCount, 1);

    var none = await request(app).get("/api/admin/applications?status=rejected").set(as(s.moderator));
    assert.deepEqual({ n: none.body.applications.length, flagged: none.body.flaggedCount }, { n: 0, flagged: 0 });
  });

  await t.test("the full application has the reasons and who flagged it", async function () {
    var s = await seedMany();
    await request(app)
      .post("/api/admin/applications/" + s.application._id + "/flag")
      .set(as(s.moderator))
      .send({ reason: "Phone is a landline in another country" });

    var res = await request(app).get("/api/admin/applications/" + s.application._id).set(as(s.moderator));
    assert.equal(res.body.application.flagged, true);
    assert.deepEqual(res.body.application.flagReasons, ["Phone is a landline in another country"]);
    assert.equal(res.body.application.flaggedBy.name, "Mo Derator");
    assert.equal(res.body.application.phoneKey, undefined, "internal fingerprints stay internal");
    assert.equal(res.body.application.resumeHash, undefined);

    var auto = await request(app).get("/api/admin/applications/" + s.flaggedAccepted._id).set(as(s.moderator));
    assert.deepEqual(auto.body.application.flagReasons, ["Same resume as another applicant"]);
    assert.equal(auto.body.application.flaggedBy, undefined, "automatic flags have no moderator");
  });

  await db.closeDatabase();
});

// ---- Applicants never see flags -------------------------------------------------------

test("B42: flags stay between staff", async function (t) {
  await db.connect();

  var HIDDEN = ["flagged", "flagReasons", "flaggedBy", "flaggedAt", "phoneKey", "resumeHash"];

  /**
   * @param {object} application - Application JSON an applicant received.
   * @returns {void}
   */
  function assertNoStaffFields(application) {
    HIDDEN.forEach(function (key) {
      assert.equal(key in application, false, key + " must not reach applicants");
    });
  }

  await t.test("not on /me, not in the response to submitting, not for flagged applications", async function (t2) {
    var s = await seed();
    mailMock.mockTransport(t2);
    await Application.updateOne(
      { _id: s.application._id },
      { $set: { flagged: true, flagReasons: ["Suspicious"], flaggedBy: s.moderator.user._id, flaggedAt: new Date(), phoneKey: "4135550100", resumeHash: "abc" } }
    );

    var mine = await request(app).get("/api/applications/me").set(as(s.applicant));
    assert.equal(mine.status, 200);
    assert.equal(mine.body.application.name, "Ada Lovelace");
    assertNoStaffFields(mine.body.application);

    var saved = await request(app).post("/api/applications").set(as(s.applicant)).field("name", "Ada King").field("status", "pending");
    assert.equal(saved.status, 200);
    assert.equal(saved.body.application.name, "Ada King");
    assertNoStaffFields(saved.body.application);
    assert.equal((await Application.findById(s.application._id)).flagged, true, "an edit doesn't clear a flag");
  });

  await t.test("not in the response to applying without an account", async function (t2) {
    var s = await seed();
    mailMock.mockTransport(t2);
    await OrgSettings.findOneAndUpdate({ key: "default" }, { $set: { publicApplications: true, autoFlagApplications: true } }, { upsert: true });
    await Application.updateOne({ _id: s.application._id }, { $set: { phoneKey: "4135550100" } });

    var res = await request(app)
      .post("/api/applications/public")
      .field("email", "twin@example.com")
      .field("name", "Ada Twin")
      .field("phone", "(413) 555-0100");
    assert.equal(res.status, 201);
    assertNoStaffFields(res.body.application);
    assert.equal((await Application.findById(res.body.application._id)).flagged, true, "but it was flagged");
  });

  await db.closeDatabase();
});

// ---- Automatic checks on submit -----------------------------------------------------

test("B42: automatic checks when an application is submitted", async function (t) {
  await db.connect();

  /**
   * Fresh database with an open round and the setting on or off.
   * @param {boolean} on - Whether automatic flagging is switched on.
   * @returns {Promise<object>} The round.
   */
  async function reset(on) {
    await db.clearDatabase();
    await EmailTemplate.seedDefaults();
    await OrgSettings.create({ key: "default", autoFlagApplications: on });
    return ApplicationRound.create({ name: "General", isOpen: true });
  }

  /**
   * Stub resume storage and email for one subtest.
   * @param {object} t2 - The subtest context.
   * @returns {void}
   */
  function stubs(t2) {
    mailMock.mockTransport(t2);
    t2.mock.method(azureBlob, "uploadResume", function fakeUpload() {
      return Promise.resolve("resumes/fake.pdf");
    });
  }

  /**
   * Submit an application as `applicant`.
   * @param {object} applicant - From fixtures.createUser.
   * @param {object} [options]
   * @param {string} [options.name="Jonathan Griffin-Smith"]
   * @param {string} [options.phone]
   * @param {Buffer} [options.file] - Resume contents.
   * @param {string} [options.fileType="application/pdf"]
   * @param {string} [options.status="pending"]
   * @returns {Promise<object>} The supertest response.
   */
  function submit(applicant, options) {
    var opts = options || {};
    var req = request(app)
      .post("/api/applications")
      .set(as(applicant))
      .field("name", opts.name || "Jonathan Griffin-Smith")
      .field("status", opts.status || "pending");
    if (opts.phone) {
      req = req.field("phone", opts.phone);
    }
    if (opts.file) {
      req = req.attach("resume", opts.file, { filename: "resume.bin", contentType: opts.fileType || "application/pdf" });
    }
    return req;
  }

  /**
   * @param {object} applicant - From fixtures.createUser.
   * @returns {Promise<object>} Their (only) stored application.
   */
  function stored(applicant) {
    return Application.findOne({ applicant: applicant.user._id });
  }

  var GOOD_PDF = files.makeTextPdf(files.RESUME_LINES);

  await t.test("the setting is off by default and only admins can change it", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var moderator = await fixtures.createUser({ role: "moderator" });

    var before = await request(app).get("/api/admin/settings").set(as(admin));
    assert.equal(before.body.settings.autoFlagApplications, false);

    assert.equal((await request(app).patch("/api/admin/settings").set(as(moderator)).send({ autoFlagApplications: true })).status, 403);
    var on = await request(app).patch("/api/admin/settings").set(as(admin)).send({ autoFlagApplications: true });
    assert.equal(on.body.settings.autoFlagApplications, true);
    var off = await request(app).patch("/api/admin/settings").set(as(admin)).send({ autoFlagApplications: false });
    assert.equal(off.body.settings.autoFlagApplications, false);
  });

  await t.test("switched off: nothing is flagged, however suspicious", async function (t2) {
    await reset(false);
    stubs(t2);
    var first = await fixtures.createUser({ role: "applicant" });
    var second = await fixtures.createUser({ role: "applicant" });
    await submit(first, { phone: "413-555-0100", file: GOOD_PDF });
    var res = await submit(second, { phone: "413-555-0100", file: GOOD_PDF, name: "Someone Else" });
    assert.equal(res.status, 200);
    assert.equal((await stored(second)).flagged, false);
    assert.deepEqual((await stored(second)).flagReasons.toObject(), []);
  });

  await t.test("switched on: a normal application with a good resume is not flagged", async function (t2) {
    await reset(true);
    stubs(t2);
    var applicant = await fixtures.createUser({ role: "applicant" });
    var res = await submit(applicant, { phone: "(413) 555-0100", file: GOOD_PDF });
    assert.equal(res.status, 200);
    var saved = await stored(applicant);
    assert.equal(saved.flagged, false);
    assert.equal(saved.phoneKey, "4135550100");
    assert.equal(saved.resumeHash, flags.fileHash(GOOD_PDF));
  });

  await t.test("a resume with almost no text is flagged (Word and PDF)", async function (t2) {
    await reset(true);
    stubs(t2);
    var pdfUser = await fixtures.createUser({ role: "applicant" });
    var docxUser = await fixtures.createUser({ role: "applicant" });
    await submit(pdfUser, { file: files.makeTextPdf(["Jonathan Griffin-Smith"]) });
    await submit(docxUser, { file: files.makeDocx(["Jonathan Griffin-Smith"]), fileType: DOCX_TYPE });

    for (var who of [pdfUser, docxUser]) {
      var saved = await stored(who);
      assert.equal(saved.flagged, true);
      assert.deepEqual(saved.flagReasons.toObject(), [flags.REASONS.resumeTooShort]);
      assert.equal(saved.flaggedBy, undefined, "automatic flags have no moderator");
      assert.ok(saved.flaggedAt);
    }
  });

  await t.test("a resume that doesn't mention the applicant is flagged", async function (t2) {
    await reset(true);
    stubs(t2);
    var applicant = await fixtures.createUser({ role: "applicant" });
    await submit(applicant, { name: "Priya Raman", file: GOOD_PDF });
    var saved = await stored(applicant);
    assert.equal(saved.flagged, true);
    assert.deepEqual(saved.flagReasons.toObject(), [flags.REASONS.resumeMissingName]);

    var inHeader = await fixtures.createUser({ role: "applicant" });
    await submit(inHeader, {
      name: "Priya Raman",
      file: files.makeDocx(files.RESUME_LINES.slice(2), { header: "Priya Raman" }),
      fileType: DOCX_TYPE,
    });
    assert.equal((await stored(inHeader)).flagged, false, "the name in a Word header counts");
  });

  await t.test("a resume we can't read is never held against the applicant", async function (t2) {
    await reset(true);
    stubs(t2);
    var applicant = await fixtures.createUser({ role: "applicant" });
    await submit(applicant, { file: files.makePdf("BT /F1 12 Tf [<0024004A>-5<00440051>] TJ ET") });
    assert.equal((await stored(applicant)).flagged, false);

    var noFile = await fixtures.createUser({ role: "applicant" });
    await submit(noFile, {});
    assert.equal((await stored(noFile)).flagged, false, "and no resume means no resume checks");
  });

  await t.test("the same phone number on another account is flagged, however it is written", async function (t2) {
    await reset(true);
    stubs(t2);
    var first = await fixtures.createUser({ role: "applicant" });
    var second = await fixtures.createUser({ role: "applicant" });
    var third = await fixtures.createUser({ role: "applicant" });
    await submit(first, { phone: "(413) 555-0100" });
    await submit(second, { phone: "+1 413.555.0100", name: "Second Person" });
    await submit(third, { phone: "413-555-0199", name: "Third Person" });

    assert.equal((await stored(first)).flagged, false, "the earlier one isn't touched");
    var dup = await stored(second);
    assert.equal(dup.flagged, true);
    assert.deepEqual(dup.flagReasons.toObject(), [flags.REASONS.duplicatePhone]);
    assert.equal((await stored(third)).flagged, false);
  });

  await t.test("the same resume file on another account is flagged; a different file isn't", async function (t2) {
    await reset(true);
    stubs(t2);
    var first = await fixtures.createUser({ role: "applicant" });
    var copycat = await fixtures.createUser({ role: "applicant" });
    var different = await fixtures.createUser({ role: "applicant" });
    await submit(first, { file: GOOD_PDF });
    await submit(copycat, { file: GOOD_PDF });
    await submit(different, { file: files.makeTextPdf(files.RESUME_LINES.concat(["One more line, so the bytes differ."])) });

    assert.deepEqual((await stored(copycat)).flagReasons.toObject(), [flags.REASONS.duplicateResume]);
    assert.equal((await stored(different)).flagged, false);
  });

  await t.test("several problems add several reasons", async function (t2) {
    await reset(true);
    stubs(t2);
    var first = await fixtures.createUser({ role: "applicant" });
    var second = await fixtures.createUser({ role: "applicant" });
    await submit(first, { phone: "413-555-0100", file: GOOD_PDF });
    await submit(second, { phone: "413-555-0100", file: GOOD_PDF, name: "Priya Raman" });

    assert.deepEqual((await stored(second)).flagReasons.toObject(), [
      flags.REASONS.resumeMissingName,
      flags.REASONS.duplicatePhone,
      flags.REASONS.duplicateResume,
    ]);
  });

  await t.test("a person's own applications to other rounds are not 'another account'", async function (t2) {
    var round = await reset(true);
    stubs(t2);
    var earlier = await ApplicationRound.create({ name: "Earlier", isOpen: false });
    var applicant = await fixtures.createUser({ role: "applicant" });
    await Application.create({
      applicant: applicant.user._id,
      round: earlier._id,
      status: "rejected",
      name: "Jonathan Griffin-Smith",
      phoneKey: "4135550100",
      resumeHash: flags.fileHash(GOOD_PDF),
    });

    var res = await submit(applicant, { phone: "413-555-0100", file: GOOD_PDF });
    assert.equal(res.status, 200);
    assert.equal(await Application.countDocuments({ round: round._id, flagged: true }), 0);
  });

  await t.test("a draft is checked when it is submitted, not when it is saved", async function (t2) {
    await reset(true);
    stubs(t2);
    var first = await fixtures.createUser({ role: "applicant" });
    var second = await fixtures.createUser({ role: "applicant" });
    await submit(first, { phone: "413-555-0100" });

    await submit(second, { phone: "413-555-0100", status: "draft", name: "Second Person" });
    assert.equal((await stored(second)).flagged, false, "still a draft");

    await submit(second, { phone: "413-555-0100", name: "Second Person" });
    assert.equal((await stored(second)).flagged, true);
  });

  await t.test("a resume uploaded with the draft counts for the duplicate check when it is submitted", async function (t2) {
    await reset(true);
    stubs(t2);
    var first = await fixtures.createUser({ role: "applicant" });
    var second = await fixtures.createUser({ role: "applicant" });
    await submit(first, { file: GOOD_PDF });
    await submit(second, { file: GOOD_PDF, status: "draft" });
    assert.equal((await stored(second)).flagged, false);

    await submit(second, {});
    assert.deepEqual((await stored(second)).flagReasons.toObject(), [flags.REASONS.duplicateResume]);
  });

  await t.test("only the first submission is checked: edits never add flags, and an unflag sticks", async function (t2) {
    await reset(true);
    stubs(t2);
    var moderator = await fixtures.createUser({ role: "moderator" });
    var first = await fixtures.createUser({ role: "applicant" });
    var second = await fixtures.createUser({ role: "applicant" });
    await submit(first, { phone: "413-555-0100" });

    // Not a duplicate when submitted; becomes one by editing afterwards.
    await submit(second, { phone: "413-555-0111", name: "Second Person" });
    await submit(second, { phone: "413-555-0100", name: "Second Person" });
    assert.equal((await stored(second)).flagged, false, "edits aren't re-checked");

    // Flagged on submission, cleared by a moderator, edited again.
    var third = await fixtures.createUser({ role: "applicant" });
    await submit(third, { phone: "413-555-0100", name: "Third Person" });
    var flagged = await stored(third);
    assert.equal(flagged.flagged, true);
    await request(app).delete("/api/admin/applications/" + flagged._id + "/flag").set(as(moderator));
    await submit(third, { phone: "413-555-0100", name: "Third Person Edited" });
    assert.equal((await stored(third)).flagged, false, "an unflag isn't undone by the next edit");
  });

  await t.test("a moderator's flag on a draft survives it being submitted", async function (t2) {
    await reset(true);
    stubs(t2);
    var moderator = await fixtures.createUser({ role: "moderator" });
    var first = await fixtures.createUser({ role: "applicant" });
    var second = await fixtures.createUser({ role: "applicant" });
    await submit(first, { phone: "413-555-0100" });
    await submit(second, { phone: "413-555-0100", status: "draft", name: "Second Person" });
    var draft = await stored(second);
    await request(app).post("/api/admin/applications/" + draft._id + "/flag").set(as(moderator)).send({ reason: "Reported by a participant" });

    await submit(second, { phone: "413-555-0100", name: "Second Person" });
    var saved = await stored(second);
    assert.deepEqual(saved.flagReasons.toObject(), ["Reported by a participant", flags.REASONS.duplicatePhone]);
    assert.equal(String(saved.flaggedBy), String(moderator.user._id), "the moderator is still recorded");
  });

  await t.test("applying without an account is checked too", async function (t2) {
    await reset(true);
    stubs(t2);
    await OrgSettings.updateOne({ key: "default" }, { $set: { publicApplications: true } });
    var first = await fixtures.createUser({ role: "applicant" });
    await submit(first, { phone: "413-555-0100", file: GOOD_PDF });

    var res = await request(app)
      .post("/api/applications/public")
      .field("email", "newcomer@example.com")
      .field("name", "Priya Raman")
      .field("phone", "413 555 0100")
      .attach("resume", GOOD_PDF, { filename: "cv.pdf", contentType: "application/pdf" });
    assert.equal(res.status, 201);
    var saved = await Application.findById(res.body.application._id);
    assert.equal(saved.flagged, true);
    assert.deepEqual(saved.flagReasons.toObject(), [
      flags.REASONS.resumeMissingName,
      flags.REASONS.duplicatePhone,
      flags.REASONS.duplicateResume,
    ]);

    var clean = await request(app)
      .post("/api/applications/public")
      .field("email", "honest@example.com")
      .field("name", "Jonathan Griffin-Smith")
      .field("phone", "413 555 0123");
    assert.equal(clean.status, 201);
    assert.equal((await Application.findById(clean.body.application._id)).flagged, false);
  });

  await t.test("a failing check never stops an application being submitted", async function (t2) {
    await reset(true);
    stubs(t2);
    t2.mock.method(resumeText, "extractText", function boom() {
      return Promise.reject(new Error("parser exploded"));
    });
    t2.mock.method(console, "error", function quiet() {});
    var applicant = await fixtures.createUser({ role: "applicant" });

    var res = await submit(applicant, { file: GOOD_PDF });
    assert.equal(res.status, 200);
    assert.equal(res.body.application.status, "pending");
    assert.equal((await stored(applicant)).flagged, false);
  });

  await db.closeDatabase();
});
