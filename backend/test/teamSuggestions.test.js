"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var app = require("../server");
var EmailLog = require("../schemas/emailLog");
var EmailTemplate = require("../schemas/emailTemplate");
var Team = require("../schemas/team");
var TeamSuggestion = require("../schemas/teamSuggestion");
var renderTemplate = require("../utils/renderTemplate");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

function suggest(who, body) {
  return request(app).post("/api/admin/team-builder/suggest").set(as(who)).send(body);
}

function mine(who) {
  return request(app).get("/api/teams/me").set(as(who));
}

function respond(who, id, action) {
  return request(app).post("/api/teams/suggestions/" + id + "/" + action).set(as(who));
}

test("suggested teams", async function (t) {
  await db.connect();
  t.after(db.closeDatabase);
  await db.clearDatabase();
  await Team.init();
  await EmailTemplate.seedDefaults();
  mailMock.mockTransport(t);

  var admin = await fixtures.createUser({ role: "admin", email: "admin@example.com", name: "Admin" });
  var mod = await fixtures.createUser({ role: "moderator" });
  var ana = await fixtures.createUser({ role: "applicant", email: "ana@umass.edu", name: "Ana Lee" });
  var ben = await fixtures.createUser({ role: "applicant", email: "ben@umass.edu", name: "Ben Ko" });
  var cy = await fixtures.createUser({ role: "applicant", email: "cy@umass.edu", name: "Cy Dee" });
  var dee = await fixtures.createUser({ role: "applicant", email: "dee@umass.edu", name: "Dee Fox" });
  var eve = await fixtures.createUser({ role: "applicant", email: "eve@umass.edu", name: "Eve Park" });
  var judge = await fixtures.createUser({ role: "judge", email: "judge@example.com", name: "Jay" });
  var outsider = await fixtures.createUser({ role: "applicant", email: "out@umass.edu", name: "Out Sider" });
  await Team.create({ name: "Rockets", nameKey: "rockets", leader: eve.user._id, members: [eve.user._id] });

  var teams = [
    { emails: ["ANA@umass.edu", "ben@umass.edu", "cy@umass.edu", "dee@umass.edu"] },
    { emails: ["eve@umass.edu", "judge@example.com", "new@example.com"] },
  ];

  await t.test("admins only, and the file is checked", async function () {
    assert.equal((await suggest(mod, { teams: teams })).status, 403);
    assert.equal((await suggest(admin, { teams: [] })).status, 400);
    assert.equal((await suggest(admin, { teams: [{ emails: ["ana@umass.edu"] }] })).status, 400);
    var dup = await suggest(admin, { teams: [teams[0], { emails: ["ana@umass.edu", "x@y.edu"] }] });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /more than one team/);
    assert.equal((await suggest(admin, { teams: teams, other: 1 })).status, 400);
  });

  await t.test("preview, then import: suggestions and emails, nobody on a team", async function () {
    var dry = await suggest(admin, { teams: teams, dryRun: true });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    assert.deepEqual(dry.body.totals, { suggested: 1, people: 4, skippedTeams: 1, skippedPeople: 2 });
    assert.deepEqual(
      dry.body.results[1].skipped.map(function r(s) {
        return s.reason;
      }),
      ['Already on "Rockets".', "Judges can't join teams."]
    );
    assert.equal(await TeamSuggestion.countDocuments(), 0, "dry run changes nothing");

    var res = await suggest(admin, { teams: teams });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.queued, 4);
    assert.equal(await TeamSuggestion.countDocuments(), 1);
    assert.equal(await Team.countDocuments(), 1, "only Rockets: nobody was put on a team");
    var logs = await EmailLog.find({ templateKey: "team_suggestion" }).lean();
    assert.equal(logs.length, 4);
    var template = await EmailTemplate.findOne({ key: "team_suggestion" }).lean();
    var values = Object.assign({ orgName: "HackTest" }, logs[0].values);
    assert.equal(renderTemplate(template.subject, values), "Your HackTest dream team is waiting");
    var text = renderTemplate(template.body, values);
    assert.match(text, /Because you asked for help finding a team/);
    assert.match(text, /Ana Lee, Ben Ko, Cy Dee and Dee Fox\./);
    assert.match(text, /\/dashboard\/team/);
    assert.doesNotMatch(text, /invited you/);

    var again = await suggest(admin, { teams: teams, dryRun: true });
    assert.equal(again.body.totals.suggested, 0, "importing again suggests nobody twice");
  });

  await t.test("the first to accept starts the team; others join it", async function () {
    var view = (await mine(ben)).body;
    assert.equal(view.team, null);
    assert.equal(view.suggestions.length, 1);
    var s = view.suggestions[0];
    assert.equal(s.team, null);
    assert.deepEqual(
      s.members.map(function n(m) {
        return [m.name, m.status, m.me];
      }),
      [
        ["Ana Lee", "pending", false],
        ["Ben Ko", "pending", true],
        ["Cy Dee", "pending", false],
        ["Dee Fox", "pending", false],
      ]
    );

    assert.equal((await respond(outsider, s._id, "accept")).status, 404, "not in this suggestion");

    var accepted = await respond(ben, s._id, "accept");
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.team.name, "Ben's team");
    assert.equal(accepted.body.team.leader.name, "Ben Ko");
    assert.deepEqual(accepted.body.suggestions, [], "on a team: no more suggestions shown");

    var cyView = (await mine(cy)).body.suggestions[0];
    assert.equal(cyView.team.name, "Ben's team");
    assert.equal(cyView.team.size, 1);
    assert.equal(
      cyView.members.filter(function b(m) {
        return m.name === "Ben Ko";
      })[0].status,
      "accepted"
    );

    var declined = await respond(cy, s._id, "decline");
    assert.equal(declined.status, 200);
    assert.deepEqual(declined.body.suggestions, []);
    assert.equal((await respond(cy, s._id, "accept")).status, 404, "declined is final");

    var anaJoin = await respond(ana, s._id, "accept");
    assert.equal(anaJoin.status, 200, JSON.stringify(anaJoin.body));
    assert.equal(anaJoin.body.team.name, "Ben's team");
    assert.equal(anaJoin.body.team.members.length, 2);
    assert.equal((await respond(ana, s._id, "accept")).status, 409, "already on a team");
    assert.equal(await Team.countDocuments(), 2);
  });

  await t.test("if everyone leaves, the next to accept starts a new team", async function () {
    var s = await TeamSuggestion.findOne();
    for (var who of [ana, ben]) {
      assert.equal((await request(app).post("/api/teams/me/leave").set(as(who))).status, 200);
    }
    var res = await respond(dee, s._id, "accept");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.team.name, "Dee's team");
    assert.equal(res.body.team.leader.name, "Dee Fox");
  });
});
