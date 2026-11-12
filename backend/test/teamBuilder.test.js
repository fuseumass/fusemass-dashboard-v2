"use strict";

process.env.AUTH_RATE_LIMIT_MAX = "500";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var parseCsv = require("csv-parse/sync").parse;

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var mockTransport = mailMock.mockTransport;
var waitFor = require("./helpers/waitFor");
var app = require("../server");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var OrgSettings = require("../schemas/orgSettings");
var Team = require("../schemas/team");
var TeamBuilderRun = require("../schemas/teamBuilderRun");
var TeamConflictNotice = require("../schemas/teamConflictNotice");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

var FORM = [
  { key: "has_team", label: "Do you have a team?", type: "select", options: ["Yes, I have a team.", "No, I do not have a team."] },
  { key: "teammates", label: "If you already have a team, please list your teammates' names and emails", type: "textarea" },
  {
    key: "research_study",
    label: "Optional research study",
    type: "select",
    options: ["Yes, I confirm and I agree to take part.", "No, do not use my data for research.", "I am under 18 (not eligible)."],
  },
  { key: "team_pairing", label: "How should we pair you with a team?", type: "select", options: ["Same major", "No preference"] },
  { key: "team_formation_event", label: "Will you come to the team formation event?", type: "select", options: ["Yes", "No"] },
];

var YES = FORM[2].options[0];
var NO = FORM[2].options[1];

/**
 * Fresh round with applicants. Everyone gets an account (as applying does).
 * @returns {Promise<object>}
 */
async function seed(maxSize) {
  await db.clearDatabase();
  await Team.init();
  await EmailTemplate.seedDefaults();
  if (maxSize) await OrgSettings.create({ key: "default", teamMaxSize: maxSize });
  var round = await ApplicationRound.create({ name: "Fall", isOpen: true, formConfig: FORM });
  var people = { round: round };
  var day = 1;
  async function person(key, email, name, answers, status, userFields) {
    var who = await fixtures.createUser(Object.assign({ role: "applicant", email: email, name: name }, userFields || {}));
    var created = new Date(2026, 8, day++);
    await Application.collection.insertOne({
      applicant: who.user._id,
      round: round._id,
      name: name,
      status: status || "accepted",
      answers: answers || {},
      createdAt: created,
      updatedAt: created,
    });
    people[key] = who;
    return who;
  }
  // Team 1: a messy "name - email" list, one listed email has no account.
  // Ben repeats the same people, Cy is silent (only wrote a name nobody matches).
  await person("ana", "ana@umass.edu", "Ana Lee", {
    has_team: "Yes, I have a team.",
    teammates: "Ben Ko - BEN@umass.edu, Cy Dee - cy@umass.edu; Dana Fox - dana.fox+hack@gmail.com",
  });
  await person("ben", "ben@umass.edu", "Ben Ko", {
    has_team: "Yes, I have a team.",
    teammates: "(Ana Lee, ana@umass.edu), cy@umass.edu, dana.fox+hack@gmail.com",
  });
  await person("cy", "cy@umass.edu", "Cy Dee", { has_team: "Yes, I have a team.", teammates: "Didy" });
  // Team 2: one member already has a dashboard team.
  await person("eve", "eve@umass.edu", "Eve Park", { has_team: "Yes, I have a team.", teammates: "Fay Wu- fay@umass.edu" });
  await person("fay", "fay@umass.edu", "Fay Wu", { has_team: "Yes, I have a team." });
  // Alone: names only, and "forming".
  await person("gus", "gus@umass.edu", "Gus Hill", { has_team: "Yes, I have a team.", teammates: "Didy, Jeffrey, Michael", research_study: YES, team_pairing: "Same major" });
  await person("hal", "hal@umass.edu", "Hal Ito", { has_team: "No, I do not have a team.", teammates: "forming", research_study: NO, team_formation_event: "Yes" });
  await person("ivy", "ivy@umass.edu", "Ivy Tan", { has_team: "No, I do not have a team." });
  // Pending applicant listing an accepted one: out of scope by default.
  await person("joe", "joe@umass.edu", "Joe Uno", { teammates: "ivy@umass.edu" }, "pending");
  // A rejected applicant listed by an accepted one.
  await person("kai", "kai@umass.edu", "Kai Vo", { teammates: "" }, "rejected");
  await person("lea", "lea@umass.edu", "Lea Wan", { teammates: "kai@umass.edu" });
  // Conflict: Max and Nia listed different people.
  await person("max", "max@umass.edu", "Max Oh", { teammates: "nia@umass.edu, oz@umass.edu" });
  await person("nia", "nia@umass.edu", "Nia Ray", { teammates: "oz@umass.edu, pat@umass.edu" });
  await person("oz", "oz@umass.edu", "Oz Kim", {});
  await person("pat", "pat@umass.edu", "Pat Lin", {});

  people.existing = await Team.create({ name: "Rockets", nameKey: "rockets", leader: people.fay.user._id, members: [people.fay.user._id] });
  // Someone outside the builder already took the default name.
  var other = await fixtures.createUser({ role: "applicant", email: "zed@example.com", name: "Zed" });
  await Team.create({ name: "Ana's team", nameKey: "ana's team", leader: other.user._id, members: [other.user._id] });

  people.admin = await fixtures.createUser({ role: "admin", email: "admin@example.com", name: "Admin Person" });
  people.mod = await fixtures.createUser({ role: "moderator" });
  return people;
}

function proposals(who, query) {
  return request(app).get("/api/admin/team-builder/proposals" + (query || "")).set(as(who));
}

function apply(who, body) {
  return request(app).post("/api/admin/team-builder/apply").set(as(who)).send(body);
}

function byEmail(list, email) {
  return list.filter(function hasEmail(p) {
    return p.members.some(function m(x) {
      return x.email === email;
    });
  })[0];
}

function emailsOf(p) {
  return p.members.map(function e(m) {
    return m.email;
  });
}

test("admin team builder", async function (t) {
  await db.connect();

  await t.test("only admins", async function () {
    var p = await seed();
    assert.equal((await proposals(p.mod)).status, 403);
    assert.equal((await apply(p.mod, { proposals: [] })).status, 403);
    assert.equal((await request(app).get("/api/admin/team-builder/unteamed").set(as(p.mod))).status, 403);
    assert.equal((await request(app).get("/api/admin/team-builder/proposals")).status, 401);
    assert.equal((await proposals(p.admin, "?statuses=bogus")).status, 400);
    assert.equal((await proposals(p.admin, "?other=1")).status, 400);
  });

  await t.test("proposals group the messy answers and flag what staff should check", async function () {
    var p = await seed();
    var res = await proposals(p.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.counts.inScope, 13);
    assert.equal(res.body.counts.saidHasTeam, 6);
    assert.equal(res.body.maxSize, 4);
    var list = res.body.proposals;
    assert.equal(list.length, 4);
    assert.deepEqual(
      [res.body.counts.ready, res.body.counts.conflicts, res.body.counts.done, res.body.counts.unmatched],
      [3, 1, 0, 2]
    );

    var first = byEmail(list, "ana@umass.edu");
    assert.deepEqual(emailsOf(first), ["ana@umass.edu", "ben@umass.edu", "cy@umass.edu", "dana.fox+hack@gmail.com"]);
    assert.equal(first.leaderEmail, "ana@umass.edu");
    assert.equal(first.status, "ready");
    assert.equal(first.defaultName, "Ana Lee's team", "Ana's team is taken, so the last name is added");
    assert.deepEqual(first.flags.noApplication, ["dana.fox+hack@gmail.com"]);
    assert.deepEqual(first.flags.noAccount, ["dana.fox+hack@gmail.com"]);
    assert.equal(first.links.mutual, 1, "Ana and Ben list each other");
    assert.equal(first.links.oneSided, 2, "Cy is silent");
    assert.equal(first.members[3].listedAs, "Dana Fox");

    var second = byEmail(list, "eve@umass.edu");
    assert.equal(second.suggestedMergeTeamId, String(p.existing._id));
    assert.equal(second.existingTeams[0].name, "Rockets");
    assert.equal(second.links.oneSided, 1);

    var third = byEmail(list, "lea@umass.edu");
    assert.equal(third.members.filter(function k(m) { return m.email === "kai@umass.edu"; })[0].status, "rejected");
    assert.equal(third.leaderEmail, "lea@umass.edu", "a rejected applicant never leads");

    var fourth = byEmail(list, "max@umass.edu");
    assert.equal(fourth.status, "conflict");
    assert.equal(fourth.conflict.reason, "mismatch");
    assert.deepEqual(emailsOf(fourth), ["max@umass.edu", "nia@umass.edu", "oz@umass.edu", "pat@umass.edu"]);
    assert.deepEqual(
      fourth.conflict.listers.map(function l(x) {
        return x.list.map(function e(y) { return y.email; });
      }),
      [["nia@umass.edu", "oz@umass.edu"], ["oz@umass.edu", "pat@umass.edu"]]
    );

    var unmatched = res.body.unmatched.map(function e(u) {
      return u.email;
    });
    assert.deepEqual(unmatched.sort(), ["gus@umass.edu", "hal@umass.edu"]);
    var gus = res.body.unmatched.filter(function g(u) {
      return u.email === "gus@umass.edu";
    })[0];
    assert.deepEqual(gus.names, ["Didy", "Jeffrey", "Michael"]);

    var wider = await proposals(p.admin, "?statuses=accepted,pending");
    assert.ok(byEmail(wider.body.proposals, "joe@umass.edu"), "pending applicants join when in scope");
  });

  await t.test("dry run counts without writing; apply creates, adds, invites and audits", async function (t2) {
    var mail = mailMock.mockTransport(t2);
    var p = await seed();
    var list = (await proposals(p.admin)).body.proposals;
    var first = byEmail(list, "ana@umass.edu");
    var second = byEmail(list, "eve@umass.edu");
    var third = byEmail(list, "lea@umass.edu");
    var body = {
      proposals: [
        { memberEmails: emailsOf(first), name: "", leaderEmail: first.leaderEmail },
        { memberEmails: emailsOf(second), mergeIntoTeamId: second.suggestedMergeTeamId },
        { memberEmails: emailsOf(third), name: "Lea crew" },
      ],
    };
    var teamsBefore = await Team.countDocuments();

    var dry = await apply(p.admin, Object.assign({ dryRun: true }, body));
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.equal(dry.body.dryRun, true);
    assert.deepEqual(
      [dry.body.totals.created, dry.body.totals.merged, dry.body.totals.added, dry.body.totals.invited],
      [1, 1, 3, 2]
    );
    assert.equal(dry.body.results[2].action, "skipped", "Lea's only teammate was rejected");
    assert.equal(await Team.countDocuments(), teamsBefore);
    assert.equal(await TeamBuilderRun.countDocuments(), 0);

    var res = await apply(p.admin, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.totals.created, 1);
    var created = await Team.findOne({ nameKey: "ana lee's team" });
    assert.ok(created, "default name made unique");
    assert.equal(String(created.leader), String(p.ana.user._id));
    assert.deepEqual(created.members.map(String).sort(), [p.ana.user._id, p.ben.user._id, p.cy.user._id].map(String).sort());
    assert.deepEqual(
      created.invites.map(function e(i) {
        return i.email;
      }),
      ["dana.fox+hack@gmail.com"]
    );
    assert.equal(String(created.invites[0].invitedBy), String(p.ana.user._id), "the leader is the inviter");
    assert.ok(created.staffChanges.some(function c(x) { return x.action === "builder_add"; }));

    var rockets = await Team.findById(p.existing._id);
    assert.equal(rockets.members.length, 1, "nobody is moved onto a team directly when merging");
    assert.deepEqual(
      rockets.invites.map(function e(i) {
        return i.email;
      }),
      ["eve@umass.edu"]
    );
    assert.equal(String(rockets.invites[0].invitedBy), String(p.fay.user._id));

    await waitFor(function sent() {
      return mail.calls.length === 2;
    }, { timeoutMs: 3000 });
    var subjects = mail.calls.map(function s(c) {
      return c.to + " " + c.subject;
    }).sort();
    assert.match(subjects[0], /^dana\.fox\+hack@gmail\.com Ana Lee invited you to join Ana Lee's team/);
    assert.match(subjects[1], /^eve@umass\.edu Fay Wu invited you to join Rockets/);

    var run = await TeamBuilderRun.findOne({});
    assert.equal(String(run.by), String(p.admin.user._id));
    assert.equal(run.totals.created, 1);
    assert.equal(run.totals.invited, 2);
    assert.equal(run.results.length, 3);

    // Running it again changes nothing: everyone is on a team or invited.
    var again = await apply(p.admin, body);
    assert.equal(again.status, 200);
    assert.equal(again.body.totals.created, 0);
    assert.equal(again.body.totals.invited, 0);
    assert.equal(again.body.totals.added, 0);
    var refreshed = (await proposals(p.admin)).body;
    assert.equal(byEmail(refreshed.proposals, "ana@umass.edu").done, true);
    assert.equal(byEmail(refreshed.proposals, "eve@umass.edu").done, true);
  });

  await t.test("server re-validates membership: no strangers, no stale proposals", async function () {
    var p = await seed();
    var list = (await proposals(p.admin)).body.proposals;
    var first = byEmail(list, "ana@umass.edu");
    var res = await apply(p.admin, {
      proposals: [
        { memberEmails: emailsOf(first).concat(["hal@umass.edu"]) },
        { memberEmails: ["ana@umass.edu", "eve@umass.edu"] },
        { memberEmails: ["ana@umass.edu", "nobody@nowhere.edu"] },
      ],
    });
    assert.equal(res.status, 200);
    res.body.results.forEach(function skipped(r) {
      assert.equal(r.action, "skipped");
      assert.match(r.reason, /aren't one proposed team/);
    });
    assert.equal(await Team.countDocuments(), 2);

    assert.equal((await apply(p.admin, { proposals: "nope" })).status, 400);
    assert.equal((await apply(p.admin, { proposals: [{ memberEmails: ["a@b.c"], mergeIntoTeamId: "x" }] })).status, 400);
    assert.equal((await apply(p.admin, { proposals: [{ memberEmails: ["a@b.c"], name: "x" }] })).status, 400);
  });

  await t.test("a group over the size limit is a conflict; locked teams are skipped", async function () {
    var p = await seed(2);
    var list = (await proposals(p.admin)).body.proposals;
    var first = byEmail(list, "ana@umass.edu");
    assert.equal(first.flags.overMax, true);
    assert.equal(first.status, "conflict");
    assert.equal(first.conflict.reason, "too_many");
    var second = byEmail(list, "eve@umass.edu");
    assert.equal(second.status, "ready");
    await Team.updateOne({ _id: p.existing._id }, { $set: { lockedAt: new Date() } });
    var res = await apply(p.admin, {
      proposals: [
        { memberEmails: emailsOf(first) },
        { memberEmails: emailsOf(second), mergeIntoTeamId: String(p.existing._id) },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.results[0].action, "skipped");
    assert.match(res.body.results[0].reason, /Resolve it manually/);
    assert.equal(res.body.results[1].action, "skipped");
    assert.match(res.body.results[1].reason, /locked/);
    assert.equal(await Team.countDocuments(), 2);
  });

  await t.test("create all ready teams: conflicts are never created, re-runs change nothing", async function (t2) {
    var mail = mockTransport(t2);
    var p = await seed();
    var list = (await proposals(p.admin)).body.proposals;
    var ready = list.filter(function r(x) { return x.status === "ready"; });
    var conflict = list.filter(function c(x) { return x.status === "conflict"; });
    assert.equal(ready.length, 3);
    assert.equal(conflict.length, 1);
    var body = {
      proposals: list.map(function toRequest(x) {
        return { memberEmails: emailsOf(x), name: x.defaultName, leaderEmail: x.leaderEmail, mergeIntoTeamId: x.suggestedMergeTeamId || undefined };
      }),
    };
    var res = await apply(p.admin, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.totals.created, 1, "Ana's group; Lea's only teammate was rejected");
    assert.equal(res.body.totals.merged, 1);
    var skipped = res.body.results.filter(function s2(r) { return r.action === "skipped"; });
    assert.equal(skipped.length, 2);
    assert.ok(skipped.some(function c(r) { return /Resolve it manually/.test(r.reason); }));
    assert.equal(await Team.countDocuments({ name: /^(Max|Nia|Oz|Pat)/ }), 0);
    assert.equal(await Team.countDocuments(), 3);
    await waitFor(function sent() {
      return mail.calls.length === 2;
    }, { timeoutMs: 3000 });

    var again = await apply(p.admin, body);
    assert.equal(again.body.totals.created, 0);
    assert.equal(again.body.totals.invited, 0);
    var after = (await proposals(p.admin)).body;
    assert.deepEqual([after.counts.ready, after.counts.conflicts, after.counts.done], [1, 1, 2]);
  });

  await t.test("conflict emails go to each lister once, and again only when the lists change", async function (t2) {
    var mail = mockTransport(t2);
    var p = await seed();
    var path = "/api/admin/team-builder/notify-conflicts";
    function notify(who, body) {
      return request(app).post(path).set(as(who)).send(body || {});
    }
    assert.equal((await request(app).post(path).send({})).status, 401);
    assert.equal((await notify(p.mod)).status, 403);
    assert.equal((await notify(p.ana)).status, 403);
    assert.equal((await notify(p.admin, { other: 1 })).status, 400);
    assert.equal((await notify(p.admin, { statuses: ["bogus"] })).status, 400);

    var dry = await notify(p.admin, { dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual([dry.body.conflicts, dry.body.people, dry.body.toEmail, dry.body.alreadyEmailed, dry.body.emailed], [1, 2, 2, 0, 0]);
    assert.equal(mail.calls.length, 0);
    assert.equal(await TeamConflictNotice.countDocuments(), 0);

    var res = await notify(p.admin);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.emailed, 2);
    await waitFor(function sent() {
      return mail.calls.length === 2;
    }, { timeoutMs: 3000 });
    var byTo = {};
    mail.calls.forEach(function index(c) {
      byTo[c.to] = c;
    });
    assert.deepEqual(Object.keys(byTo).sort(), ["max@umass.edu", "nia@umass.edu"], "silent members aren't emailed");
    assert.equal(byTo["max@umass.edu"].subject, "Your teammate list doesn't match");
    assert.match(byTo["max@umass.edu"].text, /Your teammate list doesn't match Nia Ray's list\./);
    assert.match(byTo["max@umass.edu"].text, /You listed: Nia Ray and Oz Kim\./);
    assert.match(byTo["max@umass.edu"].text, /Nia Ray listed: Oz Kim and Pat Lin\./);
    assert.match(byTo["nia@umass.edu"].text, /Max Oh listed: Nia Ray and Oz Kim\./);
    assert.match(byTo["max@umass.edu"].text, /\/dashboard\/team/);
    assert.equal(await Team.countDocuments(), 2, "emailing creates no team");

    var again = await notify(p.admin);
    assert.equal(again.body.emailed, 0);
    assert.equal(again.body.alreadyEmailed, 2);
    var racing = await Promise.all([notify(p.admin), notify(p.admin)]);
    assert.equal(racing[0].body.emailed + racing[1].body.emailed, 0);
    assert.equal(mail.calls.length, 2, "not re-sent");

    // Nia changes her list: both are told again.
    await Application.collection.updateOne(
      { applicant: p.nia.user._id },
      { $set: { "answers.teammates": "oz@umass.edu, pat@umass.edu, max@umass.edu" } }
    );
    var changed = await notify(p.admin);
    assert.equal(changed.body.emailed, 2);
    await waitFor(function sent() {
      return mail.calls.length === 4;
    }, { timeoutMs: 3000 });

    // Once Max has a team of his own, he is no longer emailed and Nia's
    // notice stands.
    await Team.create({ name: "Mavs", nameKey: "mavs", leader: p.max.user._id, members: [p.max.user._id] });
    await Application.collection.updateOne(
      { applicant: p.nia.user._id },
      { $set: { "answers.teammates": "oz@umass.edu" } }
    );
    var dry2 = await notify(p.admin, { dryRun: true });
    assert.equal(dry2.body.people, 1, "only Nia is still unteamed and in conflict");
  });

  await t.test("not on a team: accepted, no team, no invite, split by research answer, CSV", async function () {
    var p = await seed();
    // Ivy has a pending invite, so she isn't in the pool.
    await Team.updateOne({ _id: p.existing._id }, { $push: { invites: { email: "ivy@umass.edu" } } });
    var res = await request(app).get("/api/admin/team-builder/unteamed").set(as(p.admin));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    var emails = [];
    res.body.groups.forEach(function each(g) {
      g.people.forEach(function e(x) {
        emails.push(x.email);
      });
    });
    assert.deepEqual(
      emails.sort(),
      [
        "ana@umass.edu", "ben@umass.edu", "cy@umass.edu", "eve@umass.edu", "gus@umass.edu", "hal@umass.edu", "lea@umass.edu",
        "max@umass.edu", "nia@umass.edu", "oz@umass.edu", "pat@umass.edu",
      ]
    );
    assert.equal(res.body.total, 11);
    var flagged = [];
    res.body.groups.forEach(function each(g) {
      g.people.forEach(function e(x) {
        if (x.conflict) flagged.push(x.email);
      });
    });
    assert.deepEqual(flagged.sort(), ["max@umass.edu", "nia@umass.edu", "oz@umass.edu", "pat@umass.edu"]);
    assert.deepEqual(
      res.body.groups.map(function c(g) {
        return [g.label, g.count];
      }),
      [[YES, 1], [NO, 1], [FORM[2].options[2], 0], ["No answer", 9]]
    );
    var gus = res.body.groups[0].people[0];
    assert.equal(gus.pairing, "Same major");
    assert.equal(res.body.groups[1].people[0].formationEvent, "Yes");

    var csvRes = await request(app)
      .get("/api/admin/team-builder/unteamed.csv?answer=" + encodeURIComponent(YES))
      .set(as(p.admin));
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers["content-type"], /text\/csv/);
    var rows = parseCsv(csvRes.text, { bom: true, columns: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Email, "gus@umass.edu");
    assert.equal(rows[0]["How should we pair you with a team?"], "Same major");
    var none = parseCsv(
      (await request(app).get("/api/admin/team-builder/unteamed.csv?answer=__none__").set(as(p.admin))).text,
      { bom: true, columns: true }
    );
    assert.equal(none.length, 9);
  });

  await db.closeDatabase();
});
