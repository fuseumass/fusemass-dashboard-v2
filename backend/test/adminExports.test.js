"use strict";

// A well-formed but fake storage account: only the download itself is stubbed.
var FAKE_AZURE =
  "DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=" +
  Buffer.alloc(64, 7).toString("base64") +
  ";EndpointSuffix=core.windows.net";

var test = require("node:test");
var assert = require("node:assert/strict");
var stream = require("stream");
var request = require("supertest");
var parseCsv = require("csv-parse/sync").parse;

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var zipReader = require("./helpers/zipReader");
var app = require("../server");
var azureBlob = require("../utils/azureBlob");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var CheckIn = require("../schemas/checkin");
var MealService = require("../schemas/mealService");
var MealCheckIn = require("../schemas/mealCheckin");
var User = require("../schemas/user");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

/**
 * @param {string} text - CSV response text (with its BOM).
 * @returns {Array<object>} One object per row, keyed by heading.
 */
function rows(text) {
  return parseCsv(text, { bom: true, columns: true });
}

async function makeApplication(round, fields, personFields) {
  var who = await fixtures.createUser(Object.assign({ role: "applicant" }, personFields || {}));
  var application = await Application.create(
    Object.assign({ applicant: who.user._id, round: round._id, name: who.user.name, status: "pending" }, fields)
  );
  return { person: who, application: application };
}

var FORM = [
  { key: "gradYear", label: "Graduation Year", type: "select", options: ["2027", "2028"] },
  { key: "shareResume", label: "Share my resume with sponsors", type: "checkbox" },
  { key: "interests", label: "[Interests](https://example.com/i)", type: "multiselect", options: ["A", "B"] },
  { key: "phoneAgain", label: "Phone", type: "text" },
  { key: "bio", label: "About you", type: "textarea" },
  { key: "cv", label: "Resume", type: "resume" },
];

test("admin exports", async function (root) {
  await db.connect();

  await root.test("access", async function (t) {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var mod = await fixtures.createUser({ role: "moderator" });
    var person = await fixtures.createUser({ role: "applicant" });
    var urls = [
      "/api/admin/exports/applications.csv",
      "/api/admin/exports/checkins.csv",
      "/api/admin/exports/meals.csv",
      "/api/admin/exports/resumes.zip",
    ];

    await t.test("signed-out, applicants and moderators are turned away; admins get in", async function () {
      for (var url of urls) {
        assert.equal((await request(app).get(url)).status, 401, url + " without a token");
        assert.equal((await request(app).get(url).set(as(person))).status, 403, url + " as an applicant");
        assert.equal((await request(app).get(url).set(as(mod))).status, 403, url + " as a moderator");
      }
      for (var csvUrl of urls.slice(0, 3)) {
        assert.equal((await request(app).get(csvUrl).set(as(admin))).status, 200, csvUrl + " as an admin");
      }

      // The dashboard (another origin) reads the suggested file name from this header.
      var fromDashboard = await request(app).get(urls[2]).set(as(admin)).set("Origin", "http://localhost:3000");
      assert.match(fromDashboard.headers["access-control-expose-headers"], /Content-Disposition/);
    });

  });

  await root.test("applications.csv", async function (t) {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var early = await ApplicationRound.create({ name: "Early", order: 1, formConfig: FORM });
    var general = await ApplicationRound.create({ name: "General", order: 2, formConfig: [{ key: "diet", label: "Diet", type: "text" }] });

    var ada = await makeApplication(
      early,
      {
        status: "accepted",
        name: "Ada Lovelace",
        phone: "555-0100",
        age: 22,
        gender: "Woman",
        pronouns: "she/her",
        education: "Undergraduate",
        university: "UMass Amherst",
        major: "Math",
        allergies: "peanuts, shellfish",
        tshirtSize: "M",
        programmingSkills: ["Python", "C, C++"],
        hardwareSkills: ["Arduino"],
        socials: { linkedin: "https://linkedin.com/in/ada", github: "https://github.com/ada", other: [{ label: "Devpost", url: "https://devpost.com/ada" }] },
        experience: { attendedBefore: true, hackathonsAttended: 4, attendedThisBefore: false },
        resumeBlobName: "resumes/private-blob-name-1234.pdf",
        answers: { gradYear: "2027", shareResume: true, interests: ["A", "B"], bio: "I like engines.\nAnd looms.", phoneAgain: "555" },
      },
      { name: "Ada Lovelace", email: "ada@example.com", resetPasswordToken: "reset-token-should-not-leak", qrId: "qr-should-not-leak" }
    );
    await User.updateOne({ _id: ada.person.user._id }, { $set: { checkedIn: true } });
    await makeApplication(general, { status: "rejected", name: "Grace", answers: { diet: "vegan" } }, { email: "grace@example.com" });
    await makeApplication(general, { status: "draft", name: "Draft Dan" }, { email: "dan@example.com" });

    await t.test("one row per submitted application, with the right headers and values", async function () {
      var res = await request(app).get("/api/admin/exports/applications.csv").set(as(admin));
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /^text\/csv; charset=utf-8/);
      assert.match(res.headers["content-disposition"], /^attachment; filename="applications-\d{4}-\d{2}-\d{2}\.csv"$/);
      assert.equal(res.headers["cache-control"], "no-store");
      assert.ok(res.text.startsWith("﻿"), "UTF-8 BOM so Excel reads accents");
      assert.ok(res.text.includes("\r\n"));

      var table = rows(res.text);
      assert.equal(table.length, 2, "the draft is not exported");
      var adaRow = table.find(function (r) { return r.Email === "ada@example.com"; });
      assert.equal(adaRow.Name, "Ada Lovelace");
      assert.equal(adaRow.Round, "Early");
      assert.equal(adaRow.Status, "accepted");
      assert.equal(adaRow.Phone, "555-0100");
      assert.equal(adaRow.Age, "22");
      assert.equal(adaRow["Dietary restrictions / allergies"], "peanuts, shellfish");
      assert.equal(adaRow["Programming skills"], "Python; C, C++");
      assert.equal(adaRow["Other links"], "Devpost: https://devpost.com/ada");
      assert.equal(adaRow["Attended hackathons before"], "Yes");
      assert.equal(adaRow["Hackathons attended"], "4");
      assert.equal(adaRow["Has resume"], "Yes");
      assert.equal(adaRow["Checked in"], "Yes");
      assert.ok(!Number.isNaN(Date.parse(adaRow.Created)));
    });

    await t.test("custom answers are flattened into labelled columns (file uploads left out)", async function () {
      var res = await request(app).get("/api/admin/exports/applications.csv").set(as(admin));
      var table = rows(res.text);
      var headers = Object.keys(table[0]);

      assert.ok(headers.includes("Graduation Year"));
      assert.ok(headers.includes("Share my resume with sponsors"));
      assert.ok(headers.includes("Interests"), "link markup is stripped from labels");
      assert.ok(headers.includes("About you"));
      assert.ok(headers.includes("Diet"), "questions from every round get a column");
      assert.ok(!headers.includes("Resume"), "the resume upload question is not a column");
      assert.ok(headers.includes("Phone (phoneAgain)"), "a label that repeats a built-in heading gets its key added");
      assert.equal(new Set(headers).size, headers.length, "headings are unique");

      var adaRow = table.find(function (r) { return r.Email === "ada@example.com"; });
      assert.equal(adaRow["Graduation Year"], "2027");
      assert.equal(adaRow["Share my resume with sponsors"], "Yes");
      assert.equal(adaRow.Interests, "A; B");
      assert.equal(adaRow["About you"], "I like engines.\nAnd looms.");
      assert.equal(adaRow.Diet, "");
      var graceRow = table.find(function (r) { return r.Email === "grace@example.com"; });
      assert.equal(graceRow.Diet, "vegan");
      assert.equal(graceRow["Graduation Year"], "");
    });

    await t.test("never exports secrets: password hashes, tokens, QR codes, blob names", async function () {
      var res = await request(app).get("/api/admin/exports/applications.csv").set(as(admin));
      var text = res.text;
      assert.ok(!text.includes("$2a$") && !text.includes("$2b$"), "no password hashes");
      assert.ok(!text.includes("reset-token-should-not-leak"));
      assert.ok(!text.includes("qr-should-not-leak"));
      assert.ok(!text.includes("private-blob-name"));
      assert.ok(!text.includes("resumes/"));
    });

    await t.test("?round= and ?status= narrow the export; custom columns follow the round", async function () {
      var general_ = await request(app).get("/api/admin/exports/applications.csv?round=" + general._id).set(as(admin));
      var table = rows(general_.text);
      assert.equal(table.length, 1);
      assert.equal(table[0].Name, "Grace");
      assert.ok(Object.keys(table[0]).includes("Diet"));
      assert.ok(!Object.keys(table[0]).includes("Graduation Year"), "only that round's questions");

      var accepted = rows((await request(app).get("/api/admin/exports/applications.csv?status=accepted").set(as(admin))).text);
      assert.deepEqual(accepted.map(function (r) { return r.Name; }), ["Ada Lovelace"]);

      var drafts = rows((await request(app).get("/api/admin/exports/applications.csv?status=draft").set(as(admin))).text);
      assert.deepEqual(drafts.map(function (r) { return r.Name; }), ["Draft Dan"]);

      assert.equal((await request(app).get("/api/admin/exports/applications.csv?round=zzz").set(as(admin))).status, 400);
      assert.equal((await request(app).get("/api/admin/exports/applications.csv?status=zzz").set(as(admin))).status, 400);
    });

    await t.test("an export with no applications is just the header row", async function () {
      var res = await request(app)
        .get("/api/admin/exports/applications.csv?round=" + "b".repeat(24))
        .set(as(admin));
      assert.equal(res.status, 200);
      assert.equal(rows(res.text).length, 0);
      assert.ok(res.text.startsWith("﻿Round,Status,Name,Email"));
    });

  });

  await root.test("CSV formula injection", async function (t) {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.create({ name: "R", formConfig: [{ key: "q", label: "Why?", type: "text" }, { key: "l", label: "=HYPERLINK(\"http://evil.example\")", type: "text" }, { key: "t", label: "Tab", type: "text" }, { key: "c", label: "Return", type: "text" }] });

    await makeApplication(
      round,
      {
        status: "pending",
        name: '=HYPERLINK("http://evil.example/steal","Click me")',
        phone: "+15551234567",
        major: "@SUM(1+1)",
        allergies: "-2+3",
        gender: "=cmd|' /C calc'!A0",
        university: "=1+1",
        programmingSkills: ["=Python", "ok"],
        // Answers are stored as typed; a leading tab or carriage return is a formula trigger too.
        answers: { q: "=1+1", l: "+x", t: "\t=2+2", c: "\r=3+3" },
      },
      { email: "mallory@example.com" }
    );

    await t.test("cells that would run as formulas in a spreadsheet are defanged", async function () {
      var res = await request(app).get("/api/admin/exports/applications.csv").set(as(admin));
      var row = rows(res.text)[0];
      assert.equal(row.Name, "'=HYPERLINK(\"http://evil.example/steal\",\"Click me\")");
      assert.equal(row.Phone, "'+15551234567");
      assert.equal(row.Major, "'@SUM(1+1)");
      assert.equal(row["Dietary restrictions / allergies"], "'-2+3");
      assert.equal(row.Gender, "'=cmd|' /C calc'!A0");
      assert.equal(row.University, "'=1+1");
      assert.equal(row.Tab, "'\t=2+2");
      assert.equal(row.Return, "'\r=3+3");
      assert.equal(row["Programming skills"], "'=Python; ok");
      assert.equal(row["Why?"], "'=1+1");

      // Headings come from admins, but are defanged too.
      var headers = Object.keys(row);
      assert.ok(headers.includes("'=HYPERLINK(\"http://evil.example\")"), "a heading that starts with = is defanged");

      // And at the byte level: no cell starts with a formula character.
      var cells = parseCsv(res.text, { bom: true });
      cells.forEach(function (line) {
        line.forEach(function (cell) {
          assert.ok(!/^[=+\-@\t\r]/.test(cell), "unsafe cell: " + JSON.stringify(cell));
        });
      });
    });

  });

  await root.test("large exports are read in batches", async function (t) {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.create({ name: "R" });

    var total = 1100; // more than two batches of 500
    var users = [];
    for (var i = 0; i < total; i++) {
      users.push({ name: "Person " + i, email: "person" + i + "@example.com", role: "applicant" });
    }
    var created = await User.insertMany(users);
    await Application.insertMany(
      created.map(function (user) {
        return { applicant: user._id, round: round._id, name: user.name, status: "pending" };
      })
    );

    await t.test("every row arrives exactly once, in several small queries", async function (t2) {
      var find = t2.mock.method(Application, "find");
      var res = await request(app).get("/api/admin/exports/applications.csv").set(as(admin));
      assert.equal(res.status, 200);

      var table = rows(res.text);
      assert.equal(table.length, total);
      assert.equal(new Set(table.map(function (r) { return r.Email; })).size, total, "no duplicates, none missing");
      assert.ok(find.mock.callCount() >= 3, "read in batches, not all at once");
    });

  });

  await root.test("check-ins and meals", async function (t) {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin", name: "Admin Annie" });
    var mod = await fixtures.createUser({ role: "moderator", name: "Desk Dave" });
    var round = await ApplicationRound.create({ name: "R" });
    var normal = await makeApplication(round, { status: "accepted" }, { name: "Normal Nora", email: "nora@example.com" });
    var walkIn = await makeApplication(round, { status: "rejected" }, { name: "=Walk In", email: "walkin@example.com" });

    await CheckIn.create({
      user: normal.person.user._id,
      checkedInBy: mod.user._id,
      checkedInAt: new Date("2026-10-24T13:00:00Z"),
      applicationStatus: "accepted",
    });
    await CheckIn.create({
      user: walkIn.person.user._id,
      checkedInBy: admin.user._id,
      forced: true,
      forcedReason: "=approved at the desk",
      applicationStatus: "rejected",
    });

    var lunch = await MealService.create({ name: "Saturday Lunch", startsAt: new Date("2026-10-24T16:00:00Z"), endsAt: new Date("2026-10-24T17:00:00Z") });
    await MealService.create({
      name: "Vegan plate",
      createdFor: "nora@example.com",
      active: false,
      startsAt: new Date("2026-10-24T22:00:00Z"),
      endsAt: new Date("2026-10-24T23:00:00Z"),
    });
    await MealCheckIn.create({ user: normal.person.user._id, mealService: lunch._id, checkedInBy: mod.user._id });
    await MealCheckIn.create({ user: walkIn.person.user._id, mealService: lunch._id, checkedInBy: mod.user._id });

    await t.test("check-ins: who, when, scanned by, forced and why", async function () {
      var res = await request(app).get("/api/admin/exports/checkins.csv").set(as(admin));
      assert.equal(res.status, 200);
      assert.match(res.headers["content-disposition"], /filename="check-ins-\d{4}-\d{2}-\d{2}\.csv"/);
      var table = rows(res.text);
      assert.equal(table.length, 2);

      var nora = table.find(function (r) { return r.Email === "nora@example.com"; });
      assert.equal(nora.Name, "Normal Nora");
      assert.equal(nora["Checked in at"], "2026-10-24T13:00:00.000Z");
      assert.equal(nora["Checked in by"], "Desk Dave");
      assert.equal(nora["Forced check-in"], "No");
      assert.equal(nora["Forced reason"], "");
      assert.equal(nora["Application status at check-in"], "accepted");

      var forced = table.find(function (r) { return r.Email === "walkin@example.com"; });
      assert.equal(forced.Name, "'=Walk In", "formula-like names are defanged");
      assert.equal(forced["Checked in by"], "Admin Annie");
      assert.equal(forced["Forced check-in"], "Yes");
      assert.equal(forced["Forced reason"], "'=approved at the desk");
    });

    await t.test("meals: every meal with how many were served", async function () {
      var res = await request(app).get("/api/admin/exports/meals.csv").set(as(admin));
      assert.equal(res.status, 200);
      var table = rows(res.text);
      assert.equal(table.length, 2);
      assert.deepEqual(
        table.map(function (r) { return r.Meal + ":" + r.Served + ":" + r.Active; }),
        ["Saturday Lunch:2:Yes", "Vegan plate:0:No"]
      );
      assert.equal(table[1]["Only for (email)"], "nora@example.com");
    });

  });

  await root.test("resumes.zip", async function (t) {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var early = await ApplicationRound.create({ name: "Early", order: 1, formConfig: FORM });
    var general = await ApplicationRound.create({ name: "General", order: 2, formConfig: FORM });

    var blobs = {};
    function resumeFor(name, extension) {
      var blobName = "resumes/" + name + "-0011223344556677" + (extension || ".pdf");
      blobs[blobName] = Buffer.from("%PDF-1.4 resume of " + name);
      return blobName;
    }

    var share = { shareResume: true };
    var ada = await makeApplication(early, { status: "accepted", name: "Ada Lovelace", education: "Undergraduate", university: "UMass", major: "Math", resumeBlobName: resumeFor("ada"), answers: share }, { email: "ada@example.com" });
    var ada2 = await makeApplication(general, { status: "accepted", name: "Ada Lovelace", university: "MIT", resumeBlobName: resumeFor("ada2", ".docx"), answers: share }, { email: "ada2@example.com" });
    var evil = await makeApplication(early, { status: "accepted", name: "=cmd ../../etc/passwd", university: "=evil", resumeBlobName: resumeFor("evil"), answers: share }, { email: "evil@example.com" });
    var missing = await makeApplication(early, { status: "accepted", name: "Lost Blob", resumeBlobName: "resumes/gone.pdf", answers: share }, { email: "lost@example.com" });
    // None of these may be included:
    await makeApplication(early, { status: "accepted", name: "Declined Dee", resumeBlobName: resumeFor("dee"), answers: { shareResume: false } }, { email: "dee@example.com" });
    await makeApplication(early, { status: "accepted", name: "Silent Sam", resumeBlobName: resumeFor("sam"), answers: {} }, { email: "sam@example.com" });
    await makeApplication(early, { status: "rejected", name: "Rejected Rae", resumeBlobName: resumeFor("rae"), answers: share }, { email: "rae@example.com" });
    await makeApplication(early, { status: "pending", name: "Pending Pat", resumeBlobName: resumeFor("pat"), answers: share }, { email: "pat@example.com" });
    await makeApplication(early, { status: "accepted", name: "No Resume Rob", answers: share }, { email: "rob@example.com" });

    function bundle(query) {
      return request(app)
        .get("/api/admin/exports/resumes.zip" + (query || ""))
        .set(as(admin))
        .buffer(true)
        .parse(zipReader.binaryParser);
    }

    function fakeDownloads(t2) {
      var asked = [];
      t2.mock.method(azureBlob, "downloadResume", function fakeDownload(blobName) {
        asked.push(blobName);
        if (!blobs[blobName]) {
          return Promise.reject(new Error("BlobNotFound"));
        }
        return Promise.resolve(stream.Readable.from([blobs[blobName]]));
      });
      return asked;
    }

    await t.test("needs resume storage and a consent question", async function (t2) {
      delete process.env.AZURE_STORAGE_CONNECTION_STRING;
      var unconfigured = await request(app).get("/api/admin/exports/resumes.zip?consentKey=shareResume").set(as(admin));
      assert.equal(unconfigured.status, 501);

      process.env.AZURE_STORAGE_CONNECTION_STRING = FAKE_AZURE;
      var asked = fakeDownloads(t2);
      var none = await request(app).get("/api/admin/exports/resumes.zip").set(as(admin));
      assert.equal(none.status, 400);
      assert.match(none.body.error, /consentKey/);

      for (var bad of ["bio", "gradYear", "cv", "nope", "answers.shareResume", "shareResume%24ne", "a.b"]) {
        var res = await request(app).get("/api/admin/exports/resumes.zip?consentKey=" + bad).set(as(admin));
        assert.equal(res.status, 400, bad + " is not a checkbox question");
      }
      assert.equal((await request(app).get("/api/admin/exports/resumes.zip?consentKey=shareResume&round=zzz").set(as(admin))).status, 400);
      assert.equal(asked.length, 0, "nothing was downloaded for a refused request");
    });

    await t.test("only accepted, consenting applicants with a resume are bundled", async function (t2) {
      process.env.AZURE_STORAGE_CONNECTION_STRING = FAKE_AZURE;
      var asked = fakeDownloads(t2);
      var res = await bundle("?consentKey=shareResume");
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], "application/zip");
      assert.match(res.headers["content-disposition"], /^attachment; filename="resumes-\d{4}-\d{2}-\d{2}\.zip"$/);
      assert.equal(res.headers["cache-control"], "no-store");

      var files = zipReader.readZip(res.body);
      var names = Object.keys(files).sort();
      var resumeNames = names.filter(function (n) { return n.startsWith("resumes/"); });
      assert.equal(resumeNames.length, 3, "Ada, Ada, and the odd name (the lost blob has no file)");
      assert.ok(names.includes("index.csv"));

      // Only the consenting, accepted people were fetched.
      assert.deepEqual(
        asked.slice().sort(),
        [ada, ada2, evil, missing].map(function (p) { return p.application.resumeBlobName; }).sort()
      );

      // The files hold the real bytes.
      var adaFile = resumeNames.find(function (n) { return n.startsWith("resumes/Ada-Lovelace_" + String(ada.application._id).slice(-6)); });
      assert.ok(adaFile.endsWith(".pdf"));
      assert.equal(files[adaFile].toString(), "%PDF-1.4 resume of ada");
      var ada2File = resumeNames.find(function (n) { return n.startsWith("resumes/Ada-Lovelace_" + String(ada2.application._id).slice(-6)); });
      assert.ok(ada2File.endsWith(".docx"), "keeps the original extension");
      assert.notEqual(adaFile, ada2File, "two people called Ada get different file names");
    });

    await t.test("file names are safe, and the index lists who and what (no emails), defanged", async function (t2) {
      process.env.AZURE_STORAGE_CONNECTION_STRING = FAKE_AZURE;
      fakeDownloads(t2);
      var files = zipReader.readZip((await bundle("?consentKey=shareResume")).body);

      Object.keys(files).forEach(function (name) {
        assert.ok(/^(index\.csv|resumes\/[A-Za-z0-9._-]+)$/.test(name), "safe archive path: " + name);
        assert.ok(!name.includes(".."), "no path traversal: " + name);
      });

      var index = rows(files["index.csv"].toString("utf8"));
      assert.equal(index.length, 4);
      var text = files["index.csv"].toString("utf8");
      assert.ok(!text.includes("@example.com"), "no email addresses in the index");
      var evilRow = index.find(function (r) { return r.Name.includes("passwd"); });
      assert.ok(evilRow.Name.startsWith("'"), "defanged");
      assert.equal(evilRow.University, "'=evil");
      assert.match(evilRow.File, /^resumes\/[A-Za-z0-9._-]+$/);
      var adaRow = index.find(function (r) { return r.University === "UMass"; });
      assert.deepEqual([adaRow.Name, adaRow["Education level"], adaRow.Major], ["Ada Lovelace", "Undergraduate", "Math"]);
    });

    await t.test("a resume that can't be fetched is noted in the index; the rest still arrive", async function (t2) {
      process.env.AZURE_STORAGE_CONNECTION_STRING = FAKE_AZURE;
      fakeDownloads(t2);
      // The missing blob is logged as an error; keep the test output quiet.
      t2.mock.method(console, "error", function () {});
      var files = zipReader.readZip((await bundle("?consentKey=shareResume")).body);
      var index = rows(files["index.csv"].toString("utf8"));
      var lost = index.find(function (r) { return r.Name === "Lost Blob"; });
      assert.equal(lost.File, "(file not available)");
      assert.equal(Object.keys(files).filter(function (n) { return n.startsWith("resumes/"); }).length, 3);
    });

    await t.test("?round= limits the bundle to one round", async function (t2) {
      process.env.AZURE_STORAGE_CONNECTION_STRING = FAKE_AZURE;
      var asked = fakeDownloads(t2);
      var files = zipReader.readZip((await bundle("?consentKey=shareResume&round=" + general._id)).body);
      assert.deepEqual(asked, [ada2.application.resumeBlobName]);
      assert.equal(rows(files["index.csv"].toString("utf8")).length, 1);
    });

    await t.test("nobody opted in: 404, not an empty bundle", async function (t2) {
      process.env.AZURE_STORAGE_CONNECTION_STRING = FAKE_AZURE;
      fakeDownloads(t2);
      await Application.updateMany({}, { $set: { "answers.shareResume": false } });
      var res = await request(app).get("/api/admin/exports/resumes.zip?consentKey=shareResume").set(as(admin));
      assert.equal(res.status, 404);
      assert.match(res.body.error, /agreed to share/);
    });

    delete process.env.AZURE_STORAGE_CONNECTION_STRING;
  });

  await db.closeDatabase();
});
