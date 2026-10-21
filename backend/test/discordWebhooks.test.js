"use strict";

process.env.AUTH_RATE_LIMIT_MAX = "500";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var discord = require("../utils/discord");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var OrgSettings = require("../schemas/orgSettings");

var ERRORS_URL = "https://discord.example/api/webhooks/errors";
var APPS_URL = "https://discord.example/api/webhooks/applications";

/**
 * Replace global fetch for one subtest and record webhook posts.
 * @param {object} t - Subtest context.
 * @param {object} [options]
 * @param {boolean} [options.fail] - Make every post reject.
 * @returns {Array<{url: string, body: object}>}
 */
function captureFetch(t, options) {
  var calls = [];
  t.mock.method(globalThis, "fetch", function fakeFetch(url, init) {
    calls.push({ url: url, body: JSON.parse(init.body) });
    if (options && options.fail) {
      return Promise.reject(new Error("network down"));
    }
    return Promise.resolve({ ok: true, status: 204 });
  });
  return calls;
}

/**
 * Set an env var for one subtest.
 * @param {object} t - Subtest context.
 * @param {string} name - Variable name.
 * @param {string} value - Value to set.
 * @returns {void}
 */
function withEnv(t, name, value) {
  var saved = process.env[name];
  process.env[name] = value;
  t.after(function restore() {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
}

test("Discord webhooks: errors and new applications", async function (t) {
  // ---- Error reporting --------------------------------------------------------

  await t.test("does nothing while DISCORD_ERROR_WEBHOOK_URL is unset", async function (t2) {
    delete process.env.DISCORD_ERROR_WEBHOOK_URL;
    var calls = captureFetch(t2);
    await discord.reportError("GET /x", new Error("boom"));
    assert.equal(calls.length, 0);
  });

  await t.test("posts the error, scrubbed of emails, credentials and tokens, with no pings", async function (t2) {
    withEnv(t2, "DISCORD_ERROR_WEBHOOK_URL", ERRORS_URL);
    discord.resetThrottleForTests();
    var calls = captureFetch(t2);

    var err = new Error(
      "E11000 duplicate key { email: \"ada@example.com\" } via mongodb+srv://admin:s3cret@db.example.net/x " +
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjEifQ.abcDEF123 AccountKey=QUJDRA==;"
    );
    await discord.reportError("POST /api/applications", err);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ERRORS_URL);
    var content = calls[0].body.content;
    assert.match(content, /Server error/);
    assert.match(content, /POST \/api\/applications/);
    assert.match(content, /E11000 duplicate key/);
    ["ada@example.com", "s3cret", "eyJhbGciOiJIUzI1NiJ9", "QUJDRA=="].forEach(function (secret) {
      assert.equal(content.indexOf(secret), -1, "leaked " + secret);
    });
    assert.ok(content.length <= 2000);
    assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] });
  });

  await t.test("caps error posts per minute and reports how many were held back", async function (t2) {
    withEnv(t2, "DISCORD_ERROR_WEBHOOK_URL", ERRORS_URL);
    discord.resetThrottleForTests();
    var calls = captureFetch(t2);

    for (var i = 0; i < discord.ERROR_BURST + 5; i++) {
      await discord.reportError("loop", new Error("again " + i));
    }
    assert.equal(calls.length, discord.ERROR_BURST);

    // Next window: the summary of what was held back rides along.
    t2.mock.method(Date, "now", function () {
      return Date.UTC(2100, 0, 1);
    });
    await discord.reportError("later", new Error("new one"));
    assert.match(calls[calls.length - 1].body.content, /5 more errors were not posted/);
  });

  await t.test("installErrorReporting forwards console.error; a failing webhook never throws", async function (t2) {
    withEnv(t2, "DISCORD_ERROR_WEBHOOK_URL", ERRORS_URL);
    discord.resetThrottleForTests();
    var original = console.error;
    var listeners = { rejection: process.listeners("unhandledRejection"), exception: process.listeners("uncaughtException") };
    t2.after(function restore() {
      console.error = original;
      process.removeAllListeners("unhandledRejection");
      process.removeAllListeners("uncaughtException");
      listeners.rejection.forEach(function (l) { process.on("unhandledRejection", l); });
      listeners.exception.forEach(function (l) { process.on("uncaughtException", l); });
    });

    var calls = captureFetch(t2, { fail: true });
    discord.installErrorReporting();
    discord.installErrorReporting(); // idempotent
    console.error("listApplications failed:", new Error("db timeout"));

    await waitFor(function () {
      return calls.length >= 1;
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].body.content, /listApplications failed:[\s\S]*db timeout/);
  });

  // ---- New applications ----------------------------------------------------------

  await db.connect();

  await t.test("a no-account application is posted with name, school, round and a review link", async function (t2) {
    await db.clearDatabase();
    await EmailTemplate.seedDefaults();
    mailMock.mockTransport(t2);
    withEnv(t2, "DISCORD_APPLICATIONS_WEBHOOK_URL", APPS_URL);
    await OrgSettings.create({ key: "default", publicApplications: true });
    await ApplicationRound.create({ name: "General", isOpen: true });
    var calls = captureFetch(t2);

    var res = await request(app)
      .post("/api/applications/public")
      .field("email", "ada@example.com")
      .field("name", "@everyone Ada")
      .field("university", "UMass Amherst");
    assert.equal(res.status, 201);

    await waitFor(function () {
      return calls.length >= 1;
    });
    var content = calls[0].body.content;
    assert.equal(calls[0].url, APPS_URL);
    assert.match(content, /New application:\*\* @everyone Ada — UMass Amherst/);
    assert.match(content, /Round: General · applied without an account · #1 in this round/);
    assert.match(content, /\/dashboard\/admin/);
    assert.equal(content.indexOf("ada@example.com"), -1, "no email address in the post");
    assert.deepEqual(calls[0].body.allowed_mentions, { parse: [] }, "@everyone can't ping");
  });

  await t.test("logged-in: posted on the first submit only, not for drafts or re-saves", async function (t2) {
    await db.clearDatabase();
    await EmailTemplate.seedDefaults();
    mailMock.mockTransport(t2);
    withEnv(t2, "DISCORD_APPLICATIONS_WEBHOOK_URL", APPS_URL);
    await ApplicationRound.create({ name: "General", isOpen: true });
    var applicant = await fixtures.createUser({ role: "applicant" });
    var calls = captureFetch(t2);

    function save(status) {
      return request(app)
        .post("/api/applications")
        .set("Authorization", "Bearer " + applicant.token)
        .field("name", "Grace")
        .field("status", status);
    }

    assert.equal((await save("draft")).status, 200);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(calls.length, 0, "draft not posted");

    assert.equal((await save("pending")).status, 200);
    await waitFor(function () {
      return calls.length >= 1;
    });
    assert.match(calls[0].body.content, /Grace[\s\S]*applied from their account/);

    assert.equal((await save("pending")).status, 200);
    await new Promise(function (r) { setTimeout(r, 100); });
    assert.equal(calls.length, 1, "re-save not posted again");
  });

  await db.closeDatabase();
});
