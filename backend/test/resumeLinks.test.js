"use strict";

// A well-formed but fake storage account. Signing a link is pure local crypto
// with the account key, so these tests exercise the real SAS code without any
// network access; only the upload itself is stubbed.
process.env.AZURE_STORAGE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=" +
  Buffer.alloc(64, 7).toString("base64") +
  ";EndpointSuffix=core.windows.net";
process.env.AZURE_STORAGE_CONTAINER = "resumes";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var mongoose = require("mongoose");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var azureBlob = require("../utils/azureBlob");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");

var BLOB_NAME = "resumes/abc123-0011223344556677.pdf";

/**
 * Create an open round plus one applicant whose application has a resume.
 * @returns {Promise<{round: object, applicant: object, application: object}>}
 */
function seedApplicationWithResume() {
  return ApplicationRound.create({ name: "R", isOpen: true }).then(function afterRound(round) {
    return fixtures.createUser({ role: "applicant" }).then(function afterUser(applicant) {
      return Application.create({
        applicant: applicant.user._id,
        round: round._id,
        status: "pending",
        resumeBlobName: BLOB_NAME,
      }).then(function afterApp(application) {
        return { round: round, applicant: applicant, application: application };
      });
    });
  });
}

/**
 * Check a signed link points at the blob and only grants short-lived HTTPS reads.
 * @param {object} body - Response body `{ url, expiresAt }`.
 * @returns {void}
 */
function assertSignedReadLink(body) {
  var url = new URL(body.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "testacct.blob.core.windows.net");
  assert.equal(decodeURIComponent(url.pathname), "/resumes/" + BLOB_NAME);
  assert.equal(url.searchParams.get("sp"), "r", "read-only permission");
  assert.equal(url.searchParams.get("spr"), "https", "HTTPS only");
  assert.ok(url.searchParams.get("sig"), "carries a signature");

  var expiresAt = new Date(url.searchParams.get("se")).getTime();
  var ttl = expiresAt - Date.now();
  assert.ok(ttl > 0 && ttl <= azureBlob.RESUME_LINK_TTL_MS, "expires within the link TTL");
  // `se` is truncated to whole seconds; expiresAt keeps the milliseconds.
  var drift = new Date(body.expiresAt).getTime() - expiresAt;
  assert.ok(drift >= 0 && drift < 1000, "expiresAt matches the link's expiry");
}

test("resume links: private storage, signed short-lived access", async function resumeLinks(t) {
  await db.connect();

  // ---- Upload + serialization ---------------------------------------------

  await t.test("uploading stores the blob name and exposes only hasResume", async function (t2) {
    await db.clearDatabase();
    await ApplicationRound.create({ name: "R", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });
    t2.mock.method(azureBlob, "uploadResume", function fakeUpload() {
      return Promise.resolve(BLOB_NAME);
    });

    var res = await request(app)
      .post("/api/applications")
      .set("Authorization", "Bearer " + applicant.token)
      .field("name", "Ada")
      .field("status", "draft")
      .attach("resume", Buffer.from("%PDF-1.4"), { filename: "cv.pdf", contentType: "application/pdf" });

    assert.equal(res.status, 200);
    assert.equal(res.body.application.hasResume, true);
    assert.equal("resumeBlobName" in res.body.application, false);
    assert.equal("resumeUrl" in res.body.application, false);

    var saved = await Application.findOne({ applicant: applicant.user._id });
    assert.equal(saved.resumeBlobName, BLOB_NAME);
  });

  await t.test("the review list never includes blob names or legacy blob URLs", async function () {
    await db.clearDatabase();
    var seeded = await seedApplicationWithResume();
    var moderator = await fixtures.createUser({ role: "moderator" });
    // A document written by an older build, which stored the permanent URL.
    await Application.collection.insertOne({
      applicant: new mongoose.Types.ObjectId(),
      round: seeded.round._id,
      status: "pending",
      resumeUrl: "https://testacct.blob.core.windows.net/resumes/old.pdf",
    });

    var res = await request(app)
      .get("/api/admin/applications")
      .set("Authorization", "Bearer " + moderator.token);

    assert.equal(res.status, 200);
    assert.equal(res.body.applications.length, 2);
    res.body.applications.forEach(function (application) {
      assert.equal("resumeBlobName" in application, false);
      assert.equal("resumeUrl" in application, false);
    });
    var withResume = res.body.applications.filter(function (a) {
      return a.hasResume;
    });
    assert.equal(withResume.length, 1);
  });

  // ---- Applicant: own resume ----------------------------------------------

  await t.test("an applicant gets a signed read-only link to their own resume", async function () {
    await db.clearDatabase();
    var seeded = await seedApplicationWithResume();

    var res = await request(app)
      .get("/api/applications/me/resume")
      .set("Authorization", "Bearer " + seeded.applicant.token);

    assert.equal(res.status, 200);
    assertSignedReadLink(res.body);
  });

  await t.test("own resume: 404 without one, 401 when logged out", async function () {
    await db.clearDatabase();
    var round = await ApplicationRound.create({ name: "R", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });
    await Application.create({ applicant: applicant.user._id, round: round._id, status: "draft" });

    var noResume = await request(app)
      .get("/api/applications/me/resume")
      .set("Authorization", "Bearer " + applicant.token);
    assert.equal(noResume.status, 404);

    var anonymous = await request(app).get("/api/applications/me/resume");
    assert.equal(anonymous.status, 401);
  });

  // ---- Reviewers: any application ----------------------------------------

  await t.test("moderators and admins get a signed link to any applicant's resume", async function () {
    await db.clearDatabase();
    var seeded = await seedApplicationWithResume();
    var moderator = await fixtures.createUser({ role: "moderator" });
    var admin = await fixtures.createUser({ role: "admin" });

    var reviewers = [moderator, admin];
    for (var i = 0; i < reviewers.length; i++) {
      var res = await request(app)
        .get("/api/admin/applications/" + seeded.application._id + "/resume")
        .set("Authorization", "Bearer " + reviewers[i].token);
      assert.equal(res.status, 200);
      assertSignedReadLink(res.body);
    }
  });

  await t.test("another applicant cannot fetch someone else's resume link", async function () {
    await db.clearDatabase();
    var seeded = await seedApplicationWithResume();
    var other = await fixtures.createUser({ role: "applicant" });

    var res = await request(app)
      .get("/api/admin/applications/" + seeded.application._id + "/resume")
      .set("Authorization", "Bearer " + other.token);
    assert.equal(res.status, 403);
    assert.equal(res.body.url, undefined);

    var anonymous = await request(app).get("/api/admin/applications/" + seeded.application._id + "/resume");
    assert.equal(anonymous.status, 401);
  });

  await t.test("reviewer link: 404 for a malformed or unknown id", async function () {
    await db.clearDatabase();
    var moderator = await fixtures.createUser({ role: "moderator" });

    var malformed = await request(app)
      .get("/api/admin/applications/not-an-id/resume")
      .set("Authorization", "Bearer " + moderator.token);
    assert.equal(malformed.status, 404);

    var unknown = await request(app)
      .get("/api/admin/applications/" + new mongoose.Types.ObjectId() + "/resume")
      .set("Authorization", "Bearer " + moderator.token);
    assert.equal(unknown.status, 404);
  });

  await t.test("501 when blob storage isn't configured", async function (t2) {
    await db.clearDatabase();
    var seeded = await seedApplicationWithResume();
    var saved = process.env.AZURE_STORAGE_CONNECTION_STRING;
    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
    t2.after(function restore() {
      process.env.AZURE_STORAGE_CONNECTION_STRING = saved;
    });

    var res = await request(app)
      .get("/api/applications/me/resume")
      .set("Authorization", "Bearer " + seeded.applicant.token);
    assert.equal(res.status, 501);
  });

  await db.closeDatabase();
});
