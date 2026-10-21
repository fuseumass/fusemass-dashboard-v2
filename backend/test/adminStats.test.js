"use strict";

process.env.EVENT_TIMEZONE = "America/New_York";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var CheckIn = require("../schemas/checkin");
var MealService = require("../schemas/mealService");
var MealCheckIn = require("../schemas/mealCheckin");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

/**
 * Create an applicant and their application.
 * @param {object} round - ApplicationRound.
 * @param {object} fields - Application fields (status, university, ...).
 * @param {string} [created] - ISO time to backdate the application to.
 * @param {object} [person] - Reuse this applicant instead of making one.
 * @returns {Promise<{person: object, application: object}>}
 */
async function makeApplication(round, fields, created, person) {
  var who = person || (await fixtures.createUser({ role: "applicant" }));
  var application = await Application.create(
    Object.assign({ applicant: who.user._id, round: round._id, name: who.user.name, status: "pending" }, fields)
  );
  if (created) {
    await Application.collection.updateOne({ _id: application._id }, { $set: { createdAt: new Date(created) } });
  }
  return { person: who, application: application };
}

var FORM = [
  { key: "gradYear", label: "Graduation Year", type: "select", options: ["2027", "2028", "2029"] },
  { key: "shareResume", label: "Share my resume with sponsors", type: "checkbox" },
  { key: "interests", label: "[Interests](https://example.com/interests)", type: "multiselect", options: ["A", "B", "C"] },
  { key: "bio", label: "Tell us about yourself", type: "textarea" },
  { key: "cv", label: "Resume", type: "resume" },
];

/**
 * Two rounds and seven applications (see the expectations below).
 * @returns {Promise<object>} { admin, mod, early, general, people }
 */
async function seedApplications() {
  await db.clearDatabase();
  var admin = await fixtures.createUser({ role: "admin" });
  var mod = await fixtures.createUser({ role: "moderator" });
  var early = await ApplicationRound.create({ name: "Early", order: 1, formConfig: FORM });
  var general = await ApplicationRound.create({ name: "General", order: 2, formConfig: [] });

  var people = [];
  // 09-30 23:30 in New York, but already 10-01 in UTC: grouped by event time.
  people.push(
    await makeApplication(
      early,
      {
        status: "accepted",
        university: "UMass Amherst",
        education: "Undergraduate",
        gender: "Woman",
        major: "Computer Science",
        tshirtSize: "M",
        experience: { attendedBefore: false },
        answers: { gradYear: "2027", shareResume: true, interests: ["A", "B"], bio: "hi" },
      },
      "2026-10-01T03:30:00Z"
    )
  );
  people.push(
    await makeApplication(
      early,
      {
        status: "accepted",
        university: "umass amherst ",
        education: "Undergraduate",
        gender: "Man",
        major: "computer science",
        tshirtSize: "L",
        experience: { attendedBefore: true, hackathonsAttended: 3, attendedThisBefore: true },
        answers: { gradYear: "2028", shareResume: false, interests: ["A"] },
      },
      "2026-10-02T15:00:00Z"
    )
  );
  people.push(
    await makeApplication(
      early,
      {
        status: "rejected",
        university: "MIT",
        education: "Graduate",
        major: "Physics",
        answers: { gradYear: "2027" },
      },
      "2026-10-04T15:00:00Z"
    )
  );
  people.push(await makeApplication(early, { status: "pending", education: "Undergraduate", gender: "Non-binary" }, "2026-10-04T16:00:00Z"));
  // A draft was never submitted: left out of every breakdown.
  people.push(await makeApplication(early, { status: "draft", university: "MIT" }, "2026-10-10T16:00:00Z"));
  people.push(
    await makeApplication(
      general,
      { status: "waitlisted", university: "MIT", education: "Undergraduate", gender: "Woman", major: "Math", tshirtSize: "S" },
      "2026-10-05T12:00:00Z"
    )
  );
  people.push(
    await makeApplication(
      general,
      { status: "accepted", university: "MIT", education: "Undergraduate", gender: "Man", major: "Math" },
      "2026-10-05T13:00:00Z"
    )
  );

  return { admin: admin, mod: mod, early: early, general: general, people: people };
}

function labels(chart) {
  return chart.buckets.map(function toPair(b) {
    return b.label + ":" + b.count;
  });
}

test("admin statistics", async function (t) {
  await db.connect();
  var seeded = await seedApplications();

  await t.test("only admins may read it", async function () {
    assert.equal((await request(app).get("/api/admin/stats")).status, 401);
    assert.equal((await request(app).get("/api/admin/stats").set(as(seeded.people[0].person))).status, 403);
    assert.equal((await request(app).get("/api/admin/stats").set(as(seeded.mod))).status, 403);
    assert.equal((await request(app).get("/api/admin/stats").set(as(seeded.admin))).status, 200);
  });

  await t.test("counts by status and by round (drafts counted apart)", async function () {
    var res = await request(app).get("/api/admin/stats").set(as(seeded.admin));
    var a = res.body.applications;
    assert.equal(a.total, 6, "submitted applications: the draft is not one");
    assert.deepEqual(a.byStatus, { draft: 1, pending: 1, accepted: 3, rejected: 1, waitlisted: 1 });
    assert.equal(a.byRound.length, 2);
    assert.equal(a.byRound[0].name, "Early");
    assert.equal(a.byRound[0].total, 4);
    assert.deepEqual(a.byRound[0].byStatus, { draft: 1, pending: 1, accepted: 2, rejected: 1, waitlisted: 0 });
    assert.equal(a.byRound[1].name, "General");
    assert.equal(a.byRound[1].total, 2);
    assert.deepEqual(a.byRound[1].byStatus, { draft: 0, pending: 0, accepted: 1, rejected: 0, waitlisted: 1 });
    assert.deepEqual(res.body.filters, { round: null, status: null });
  });

  await t.test("breakdowns by school, education, gender, major and T-shirt size", async function () {
    var a = (await request(app).get("/api/admin/stats").set(as(seeded.admin))).body.applications;

    // Spelling and spacing variants of one school are one school.
    assert.deepEqual(labels(a.bySchool), ["MIT:3", "UMass Amherst:2", "Not provided:1"]);
    assert.equal(a.bySchool.total, 6);
    assert.equal(a.bySchool.distinct, 3);
    assert.deepEqual(labels(a.byEducation), ["Undergraduate:5", "Graduate:1"]);
    assert.deepEqual(labels(a.byGender).sort(), ["Man:2", "Non-binary:1", "Not provided:1", "Woman:2"]);
    assert.equal(a.byMajor.buckets.find(function (b) { return b.label.toLowerCase() === "computer science"; }).count, 2);
    assert.equal(a.byMajor.buckets.find(function (b) { return b.label === "Math"; }).count, 2);
    assert.equal(a.byTshirtSize.buckets.find(function (b) { return b.label === "Not provided"; }).count, 3);
    assert.equal(a.byTshirtSize.buckets.find(function (b) { return b.label === "M"; }).count, 1);
  });

  await t.test("first-time hackers", async function () {
    var a = (await request(app).get("/api/admin/stats").set(as(seeded.admin))).body.applications;
    assert.deepEqual(a.experience, { firstTime: 5, returning: 1, attendedThisEvent: 1 });
  });

  await t.test("graduation year and custom choice questions come from the forms", async function () {
    var a = (await request(app).get("/api/admin/stats").set(as(seeded.admin))).body.applications;

    assert.equal(a.byGraduationYear.key, "gradYear");
    assert.equal(a.byGraduationYear.label, "Graduation Year");
    assert.deepEqual(labels(a.byGraduationYear), ["2027:2", "2028:1"]);

    var keys = a.questions.map(function (q) { return q.key; }).sort();
    assert.deepEqual(keys, ["interests", "shareResume"], "text and file questions are not charted, nor the graduation year twice");
    var interests = a.questions.find(function (q) { return q.key === "interests"; });
    assert.equal(interests.label, "Interests", "link markup is stripped from the label");
    assert.equal(interests.type, "multiselect");
    assert.deepEqual(labels(interests), ["A:2", "B:1"], "a multiselect counts each choice");
    var share = a.questions.find(function (q) { return q.key === "shareResume"; });
    assert.deepEqual(labels(share), ["No:1", "Yes:1"]);
    assert.ok(a.questions.every(function (q) { return !("graduation" in q); }));
  });

  await t.test("submissions per day, in the event's time zone, gaps filled", async function () {
    var res = await request(app).get("/api/admin/stats").set(as(seeded.admin));
    assert.equal(res.body.timeZone, "America/New_York");
    var days = res.body.applications.submissionsPerDay;
    assert.deepEqual(
      days.map(function (d) { return d.date + ":" + d.total; }),
      ["2026-09-30:1", "2026-10-01:0", "2026-10-02:1", "2026-10-03:0", "2026-10-04:2", "2026-10-05:2"]
    );
    assert.equal(days[0].byStatus.accepted, 1);
    assert.equal(days[4].byStatus.rejected, 1);
    assert.equal(days[4].byStatus.pending, 1);
    assert.equal(days[5].byStatus.waitlisted, 1);
    assert.equal(days[5].byStatus.accepted, 1);
  });

  await t.test("?round= limits the breakdowns to one round; the round table stays whole", async function () {
    var res = await request(app).get("/api/admin/stats?round=" + seeded.general._id).set(as(seeded.admin));
    assert.equal(res.status, 200);
    var a = res.body.applications;
    assert.equal(a.total, 2);
    assert.deepEqual(a.byStatus, { draft: 0, pending: 0, accepted: 1, rejected: 0, waitlisted: 1 });
    assert.deepEqual(labels(a.bySchool), ["MIT:2"]);
    assert.equal(a.byRound.length, 2, "every round is still listed");
    assert.equal(a.byGraduationYear, null, "that round's form has no graduation question");
    assert.deepEqual(a.questions, []);
    assert.equal(res.body.filters.round, String(seeded.general._id));

    var early = await request(app).get("/api/admin/stats?round=" + seeded.early._id).set(as(seeded.admin));
    assert.equal(early.body.applications.total, 4);
    assert.deepEqual(labels(early.body.applications.byGraduationYear), ["2027:2", "2028:1"]);
  });

  await t.test("?status= limits the breakdowns to one status", async function () {
    var accepted = (await request(app).get("/api/admin/stats?status=accepted").set(as(seeded.admin))).body;
    assert.equal(accepted.applications.total, 3);
    assert.deepEqual(labels(accepted.applications.bySchool), ["UMass Amherst:2", "MIT:1"]);
    assert.equal(accepted.applications.byStatus.accepted, 3, "the status table is never filtered by status");
    assert.equal(accepted.applications.byStatus.rejected, 1);
    assert.equal(accepted.filters.status, "accepted");

    var drafts = (await request(app).get("/api/admin/stats?status=draft").set(as(seeded.admin))).body;
    assert.equal(drafts.applications.total, 1);
    assert.deepEqual(labels(drafts.applications.bySchool), ["MIT:1"]);
  });

  await t.test("bad filters are rejected", async function () {
    assert.equal((await request(app).get("/api/admin/stats?round=nope").set(as(seeded.admin))).status, 400);
    assert.equal((await request(app).get("/api/admin/stats?status=nope").set(as(seeded.admin))).status, 400);
    // An id that isn't a round is simply an empty round.
    var none = await request(app).get("/api/admin/stats?round=" + "a".repeat(24)).set(as(seeded.admin));
    assert.equal(none.status, 200);
    assert.equal(none.body.applications.total, 0);
    assert.deepEqual(none.body.applications.bySchool, { total: 0, distinct: 0, buckets: [], other: { distinct: 0, count: 0 } });
  });

  await t.test("everything is counted in MongoDB; documents are never loaded", async function (t2) {
    var find = t2.mock.method(Application, "find", function () {
      throw new Error("stats must not load applications");
    });
    var res = await request(app).get("/api/admin/stats").set(as(seeded.admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.applications.total, 6);
    assert.equal(find.mock.callCount(), 0);
  });

  await t.test("the long tail of schools is folded into 'other'", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.create({ name: "R" });
    for (var i = 0; i < 30; i++) {
      await makeApplication(round, { university: "School " + i });
    }
    await makeApplication(round, { university: "School 0" });
    var a = (await request(app).get("/api/admin/stats").set(as(admin))).body.applications;
    assert.equal(a.bySchool.buckets.length, 25);
    assert.deepEqual(a.bySchool.buckets[0], { label: "School 0", count: 2 });
    assert.equal(a.bySchool.distinct, 30);
    assert.equal(a.bySchool.total, 31);
    assert.deepEqual(a.bySchool.other, { distinct: 5, count: 5 });
  });

  await t.test("event day: arrivals, forced check-ins, meals served", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.create({ name: "R" });
    var second = await ApplicationRound.create({ name: "R2" });

    // Two people, each accepted in both rounds: still two attendees.
    var one = await makeApplication(round, { status: "accepted" });
    await makeApplication(second, { status: "accepted" }, null, one.person);
    var two = await makeApplication(round, { status: "accepted" });
    await makeApplication(second, { status: "accepted" }, null, two.person);
    var walkIn = await makeApplication(round, { status: "rejected" });
    await makeApplication(round, { status: "pending" });

    await CheckIn.create({ user: one.person.user._id, checkedInBy: admin.user._id });
    await CheckIn.create({ user: walkIn.person.user._id, checkedInBy: admin.user._id, forced: true, forcedReason: "approved at the desk" });

    var lunch = await MealService.create({ name: "Lunch", startsAt: new Date("2026-10-24T16:00:00Z"), endsAt: new Date("2026-10-24T17:00:00Z") });
    var dinner = await MealService.create({
      name: "Dinner",
      createdFor: "vegan@example.com",
      startsAt: new Date("2026-10-24T22:00:00Z"),
      endsAt: new Date("2026-10-24T23:00:00Z"),
    });
    await MealService.create({ name: "Breakfast", startsAt: new Date("2026-10-25T12:00:00Z"), endsAt: new Date("2026-10-25T13:00:00Z") });
    await MealCheckIn.create({ user: one.person.user._id, mealService: lunch._id, checkedInBy: admin.user._id });
    await MealCheckIn.create({ user: two.person.user._id, mealService: lunch._id, checkedInBy: admin.user._id });
    await MealCheckIn.create({ user: one.person.user._id, mealService: dinner._id, checkedInBy: admin.user._id });

    var res = await request(app).get("/api/admin/stats").set(as(admin));
    var e = res.body.eventDay;
    assert.equal(e.acceptedAttendees, 2);
    assert.equal(e.checkedIn, 2);
    assert.equal(e.forcedCheckIns, 1);
    assert.equal(e.mealsServed, 3);
    assert.deepEqual(
      e.meals.map(function (m) { return m.name + ":" + m.served; }),
      ["Lunch:2", "Dinner:1", "Breakfast:0"]
    );
    assert.equal(e.workshopAttendance, null, "no workshops module yet");
    assert.equal(e.hardwareOut, null, "no hardware module yet");

    // Counts only: nothing that identifies a person.
    var text = JSON.stringify(res.body);
    assert.ok(!text.includes("@example.com"), "no email addresses");
    assert.ok(!text.includes("approved at the desk"), "no check-in reasons");
  });

  await t.test("an empty database gives zeros, not errors", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var res = await request(app).get("/api/admin/stats").set(as(admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.applications.total, 0);
    assert.deepEqual(res.body.applications.byRound, []);
    assert.deepEqual(res.body.applications.submissionsPerDay, []);
    assert.deepEqual(res.body.applications.experience, { firstTime: 0, returning: 0, attendedThisEvent: 0 });
    assert.equal(res.body.eventDay.acceptedAttendees, 0);
    assert.equal(res.body.eventDay.mealsServed, 0);
  });

  await db.closeDatabase();
});
