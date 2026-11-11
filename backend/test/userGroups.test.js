"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var parseCsv = require("csv-parse/sync").parse;

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var backgroundWorkers = require("../utils/backgroundWorkers");
var outbox = require("../utils/outbox");
var autoAccept = require("../utils/autoAccept");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var User = require("../schemas/user");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

function rows(text) {
  return parseCsv(text, { bom: true, columns: true });
}

var FORM = [
  { key: "meal_accommodations", label: "Would you require meal accommodations?", type: "select", options: ["Yes, I would.", "No, I do not."] },
  { key: "research_study", label: "Optional research study", type: "select", options: ["Yes, I agree.", "No, do not use my data."] },
  { key: "goals", label: "Goals", type: "multiselect", options: ["Learn", "Win", "Meet people"] },
  { key: "mlh_coc", label: "I agree to the [code of conduct](https://example.com/coc)", type: "checkbox" },
  { key: "notes", label: "Anything else?", type: "textarea" },
  { key: "cv", label: "Resume", type: "resume" },
];

async function person(round, email, fields, userFields) {
  var who = await fixtures.createUser(Object.assign({ role: "applicant", email: email, name: email.split("@")[0] }, userFields || {}));
  await Application.create(
    Object.assign({ applicant: who.user._id, round: round._id, name: who.user.name, status: "pending" }, fields || {})
  );
  return who;
}

function emailsOf(table) {
  return table
    .map(function (r) {
      return r.Email;
    })
    .sort();
}

test("admin user groups", async function (root) {
  await db.connect();
  await db.clearDatabase();

  var admin = await fixtures.createUser({ role: "admin" });
  var mod = await fixtures.createUser({ role: "moderator" });
  var applicant = await fixtures.createUser({ role: "applicant" });

  var old = await ApplicationRound.create({ name: "Old round", isOpen: false, order: 0, formConfig: [] });
  var round = await ApplicationRound.create({ name: "Current round", isOpen: true, order: 1, formConfig: FORM });

  // a: umass.edu, vegetarian, research yes, accepted, checked in
  await person(
    round,
    "a@umass.edu",
    {
      status: "accepted",
      allergies: "Vegetarian",
      university: "UMass Amherst",
      tshirtSize: "M",
      answers: { meal_accommodations: "No, I do not.", research_study: "Yes, I agree.", goals: ["Learn", "Win"], mlh_coc: true },
    },
    { checkedIn: true }
  );
  // b: cs.umass.edu (subdomain), "None", needs meal accommodations
  await person(round, "b@cs.umass.edu", {
    status: "accepted",
    allergies: " None ",
    university: "umass amherst ",
    answers: { meal_accommodations: "Yes, I would.", research_study: "No, do not use my data.", goals: ["Meet people"] },
  });
  // c: gmail, "n/a", research yes, pending, flagged
  await person(round, "c@gmail.com", {
    status: "pending",
    allergies: "N/A",
    flagged: true,
    answers: { research_study: "Yes, I agree.", goals: ["Learn"] },
  });
  // d: umass.edu, "no", rejected; formula-looking name
  await person(round, "d@umass.edu", {
    status: "rejected",
    name: "=HYPERLINK(\"http://evil.example\")",
    allergies: "no",
    answers: { notes: "+1 for pizza", goals: [] },
  });
  // e: notumass.edu must never match umass.edu
  await person(round, "e@notumass.edu", { status: "pending", allergies: "na", answers: {} });
  // f: a draft (left out unless asked for)
  await person(round, "f@umass.edu", { status: "draft", allergies: "peanuts" });
  // g: another round entirely
  await person(old, "g@umass.edu", { status: "accepted", allergies: "gluten" });

  function group(query) {
    return request(app).get("/api/admin/groups").query(query || {}).set(as(admin));
  }

  await root.test("access: admins only", async function () {
    var urls = ["/api/admin/groups", "/api/admin/groups/options", "/api/admin/groups/emails", "/api/admin/groups/export.csv"];
    for (var url of urls) {
      assert.equal((await request(app).get(url)).status, 401, url);
      assert.equal((await request(app).get(url).set(as(applicant))).status, 403, url);
      assert.equal((await request(app).get(url).set(as(mod))).status, 403, url);
      assert.equal((await request(app).get(url).set(as(admin))).status, 200, url);
    }
  });

  await root.test("defaults to the open round, without drafts", async function () {
    var res = await group();
    assert.equal(res.status, 200);
    assert.equal(res.body.round.name, "Current round");
    assert.equal(res.body.total, 5);
    assert.equal(res.body.byStatus.draft, 0);
    assert.equal(res.body.byStatus.accepted, 2);
    assert.equal(res.body.checkedIn.yes, 1);
    assert.equal(res.body.flagged.yes, 1);
    var school = res.body.byUniversity.buckets.find(function (b) {
      return b.label.toLowerCase() === "umass amherst";
    });
    assert.equal(school.count, 2, "school names group ignoring case and spaces");
    assert.equal(JSON.stringify(res.body).indexOf("@"), -1, "no emails in the summary");

    var other = await group({ round: String(old._id) });
    assert.equal(other.body.total, 1);
  });

  await root.test("options list domains, statuses and the form's choice questions", async function () {
    var res = await request(app).get("/api/admin/groups/options").set(as(admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.round.name, "Current round");
    assert.equal(res.body.rounds.length, 2);
    assert.equal(res.body.statuses.draft, 1);
    assert.deepEqual(res.body.domains[0], { domain: "umass.edu", count: 2 });
    var keys = res.body.questions.map(function (q) {
      return q.key;
    });
    assert.deepEqual(keys, ["meal_accommodations", "research_study", "goals", "mlh_coc"]);
    var research = res.body.questions[1];
    assert.deepEqual(research.values, [
      { value: "Yes, I agree.", count: 2 },
      { value: "No, do not use my data.", count: 1 },
    ]);
    var coc = res.body.questions[3];
    assert.equal(coc.label, "I agree to the code of conduct");
    assert.deepEqual(coc.values, [
      { value: "Yes", count: 1 },
      { value: "No", count: 4 },
    ]);
    assert.deepEqual(res.body.mealQuestions, [{ key: "meal_accommodations", label: "Would you require meal accommodations?" }]);

    assert.equal((await request(app).get("/api/admin/groups/options?status=accepted").set(as(admin))).status, 400);
  });

  await root.test("email domain, with and without subdomains", async function () {
    var exact = await group({ domain: "umass.edu" });
    assert.equal(exact.body.total, 2, "a and d; not cs.umass.edu, not notumass.edu, not the draft");
    var withSubs = await group({ domain: "UMASS.edu", subdomains: "true" });
    assert.equal(withSubs.body.total, 3);
    var fromEmail = await group({ domain: "someone@gmail.com" });
    assert.equal(fromEmail.body.total, 1, "an address is read as its domain, like auto-accept");
    var several = await group({ domain: "gmail.com,notumass.edu" });
    assert.equal(several.body.total, 2);
  });

  await root.test("dietary rule treats none / n/a / na / no as no restriction", async function () {
    var restrictions = await group({ dietary: "restrictions" });
    assert.equal(restrictions.body.total, 1, "only Vegetarian");
    var accommodations = await group({ dietary: "accommodations" });
    assert.equal(accommodations.body.total, 1);
    var any = await group({ dietary: "any" });
    assert.equal(any.body.total, 2);
    var none = await group({ dietary: "none" });
    assert.equal(none.body.total, 3);
    var all = await group();
    assert.deepEqual(all.body.dietary, { restrictions: 1, accommodations: 1, any: 2, none: 3 });
  });

  await root.test("form answer filters", async function () {
    var research = await group({ answer: "research_study:Yes, I agree." });
    assert.equal(research.body.total, 2);
    var multi = await group({ answer: ["goals:Learn", "goals:Meet people"] });
    assert.equal(multi.body.total, 3, "choices of one question are OR'd, and match inside lists");
    var both = await group({ answer: ["goals:Learn", "research_study:No, do not use my data."] });
    assert.equal(both.body.total, 0, "different questions are AND'd");
    var ticked = await group({ answer: "mlh_coc:Yes" });
    assert.equal(ticked.body.total, 1);
    var unticked = await group({ answer: "mlh_coc:No" });
    assert.equal(unticked.body.total, 4);
  });

  await root.test("combined filters", async function () {
    var res = await group({
      domain: "umass.edu",
      subdomains: "true",
      status: "accepted",
      dietary: "any",
      checkedIn: "false",
    });
    assert.equal(res.body.total, 1, "only b");
    var flagged = await group({ flagged: "true", answer: "research_study:Yes, I agree." });
    assert.equal(flagged.body.total, 1);
    var checked = await group({ checkedIn: "true", domain: "umass.edu" });
    assert.equal(checked.body.total, 1);
    var drafts = await group({ status: "draft" });
    assert.equal(drafts.body.total, 1);
  });

  await root.test("emails are the matching group's, comma-ready", async function () {
    var res = await request(app).get("/api/admin/groups/emails").query({ domain: "umass.edu", subdomains: "true" }).set(as(admin));
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.body.emails, ["a@umass.edu", "b@cs.umass.edu", "d@umass.edu"]);
  });

  await root.test("CSV export: columns, answers and formula escaping", async function () {
    var res = await request(app).get("/api/admin/groups/export.csv").query({ domain: "umass.edu", subdomains: "true" }).set(as(admin));
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^text\/csv/);
    assert.match(res.headers["content-disposition"], /filename="user-group-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.equal(res.headers["cache-control"], "no-store");

    var lines = res.text.replace(/^﻿/, "").split("\r\n");
    assert.ok(
      lines[0].startsWith(
        "Name,Email,Status,University,Major,Phone,T-shirt size,Food restrictions,Meal accommodations,Checked in,Flagged,"
      ),
      lines[0]
    );
    var table = rows(res.text);
    assert.deepEqual(emailsOf(table), ["a@umass.edu", "b@cs.umass.edu", "d@umass.edu"]);
    var a = table.find(function (r) { return r.Email === "a@umass.edu"; });
    assert.equal(a["Food restrictions"], "Vegetarian");
    assert.equal(a["Meal accommodations"], "No");
    assert.equal(a["Checked in"], "Yes");
    assert.equal(a.Goals, "Learn; Win");
    assert.equal(a["I agree to the code of conduct"], "Yes");
    assert.equal(a["Optional research study"], "Yes, I agree.");
    assert.equal(a.Resume, undefined, "file uploads are not exported");
    var b = table.find(function (r) { return r.Email === "b@cs.umass.edu"; });
    assert.equal(b["Meal accommodations"], "Yes");
    var d = table.find(function (r) { return r.Email === "d@umass.edu"; });
    assert.equal(d.Name, "'=HYPERLINK(\"http://evil.example\")", "formulas are neutralized");
    assert.equal(d["Anything else?"], "'+1 for pizza");
    assert.equal(res.text.indexOf("passwordHash"), -1);
  });

  await root.test("invalid parameters are a 400", async function () {
    var bad = [
      { domain: "not a domain" },
      { domain: "-bad-.com" },
      { status: "approved" },
      { status: "accepted,maybe" },
      { dietary: "vegan" },
      { checkedIn: "yes" },
      { flagged: "maybe" },
      { subdomains: "sometimes" },
      { answer: "nope:Yes" },
      { answer: "notes:anything" },
      { answer: "cv:anything" },
      { answer: "research_study" },
      { answer: "mlh_coc:Maybe" },
      { answer: "answers.$where:1" },
      { round: "123" },
      { colour: "blue" },
    ];
    for (var query of bad) {
      var res = await group(query);
      assert.equal(res.status, 400, JSON.stringify(query) + " -> " + res.status);
      assert.ok(res.body.error);
    }
    // Operator objects from qs-style brackets are not strings.
    for (var raw of ["domain[$ne]=x", "status[$ne]=draft", "answer[$gt]=", "dietary[$ne]=none", "checkedIn[$ne]=true", "round[$ne]=x"]) {
      var injected = await request(app).get("/api/admin/groups?" + raw).set(as(admin));
      assert.equal(injected.status, 400, raw);
    }
    assert.equal((await group({ round: "aaaaaaaaaaaaaaaaaaaaaaaa" })).status, 404);
    assert.equal((await request(app).get("/api/admin/groups/export.csv?status=nope").set(as(admin))).status, 400);
    assert.equal((await request(app).get("/api/admin/groups/emails?dietary=nope").set(as(admin))).status, 400);
  });

  await root.test("DISABLE_BACKGROUND_WORKERS keeps the outbox and auto-accept off", async function (t) {
    var started = [];
    t.mock.method(outbox, "startWorker", function () {
      started.push("outbox");
    });
    t.mock.method(autoAccept, "startWorker", function () {
      started.push("autoAccept");
    });
    var logged = [];
    t.mock.method(console, "log", function (message) {
      logged.push(message);
    });

    assert.equal(backgroundWorkers.start({ DISABLE_BACKGROUND_WORKERS: "true" }), false);
    assert.equal(backgroundWorkers.start({ DISABLE_BACKGROUND_WORKERS: "1" }), false);
    assert.deepEqual(started, []);
    assert.deepEqual(logged, ["Background workers disabled.", "Background workers disabled."]);

    assert.equal(backgroundWorkers.start({}), true);
    assert.equal(backgroundWorkers.start({ DISABLE_BACKGROUND_WORKERS: "false" }), true);
    assert.deepEqual(started, ["outbox", "autoAccept", "outbox", "autoAccept"]);
  });

  // Nothing above may have changed an application or a user.
  await root.test("read-only", async function () {
    assert.equal(await Application.countDocuments({ status: "accepted" }), 3);
    assert.equal(await User.countDocuments({ checkedIn: true }), 1);
  });

  await db.closeDatabase();
});
