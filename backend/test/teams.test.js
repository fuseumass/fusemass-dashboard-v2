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
var teamController = require("../controllers/teamController");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var OrgSettings = require("../schemas/orgSettings");
var Team = require("../schemas/team");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

/**
 * Fresh database with templates, optional team size, and named users.
 * @param {number} [maxSize] - OrgSettings.teamMaxSize.
 * @returns {Promise<object>} Users by name.
 */
async function seed(maxSize) {
  await db.clearDatabase();
  // The rules these tests check live in unique indexes; make sure they're
  // built (on a fresh test database they're created in the background).
  await Team.init();
  await EmailTemplate.seedDefaults();
  if (maxSize) await OrgSettings.create({ key: "default", teamMaxSize: maxSize });
  var people = {};
  for (var name of ["ada", "grace", "linus", "barbara"]) {
    people[name] = await fixtures.createUser({ role: "applicant", name: name, email: name + "@example.com" });
  }
  people.mod = await fixtures.createUser({ role: "moderator" });
  people.admin = await fixtures.createUser({ role: "admin" });
  return people;
}

function createTeam(who, name) {
  return request(app).post("/api/teams").set(as(who)).send({ name: name });
}
function invite(who, email) {
  return request(app).post("/api/teams/me/invites").set(as(who)).send({ email: email });
}
function mine(who) {
  return request(app).get("/api/teams/me").set(as(who));
}
function accept(who, teamId) {
  return request(app).post("/api/teams/invites/" + teamId + "/accept").set(as(who));
}

test("teams", async function (t) {
  await t.test("Devpost links: only project pages, normalized", function () {
    var n = teamController.normalizeDevpostUrl;
    assert.equal(n("https://devpost.com/software/My-App"), "https://devpost.com/software/my-app");
    assert.equal(n("devpost.com/software/my-app/"), "https://devpost.com/software/my-app");
    assert.equal(n("http://www.devpost.com/software/my_app?ref=x#top"), "https://devpost.com/software/my_app");
    assert.equal(n("https://hackumass-xiv.devpost.com/"), null, "a hackathon page isn't a project");
    assert.equal(n("https://devpost.com.evil.example/software/x"), null);
    assert.equal(n("https://example.com/software/x"), null);
    assert.equal(n("javascript:alert(1)//devpost.com/software/x"), null);
  });

  await db.connect();

  await t.test("create a team; one team per person; names unique ignoring case", async function () {
    var p = await seed();
    var res = await createTeam(p.ada, "  Byte   Me ");
    assert.equal(res.status, 201);
    assert.equal(res.body.team.name, "Byte Me");
    assert.equal(res.body.team.leader.email, "ada@example.com");
    assert.equal(res.body.team.members.length, 1);
    assert.equal(res.body.team.maxSize, 4);

    assert.equal((await createTeam(p.ada, "Another")).status, 409, "already on a team");
    var taken = await createTeam(p.grace, "byte me");
    assert.equal(taken.status, 409);
    assert.match(taken.body.error, /name is taken/);
    assert.equal((await createTeam(p.grace, "x")).status, 400);
    assert.equal((await request(app).post("/api/teams").send({ name: "Nope" })).status, 401);
  });

  await t.test("invite by email: the invitee is emailed and sees it; duplicates refused", async function (t2) {
    var p = await seed();
    var mail = mailMock.mockTransport(t2);
    var team = (await createTeam(p.ada, "Byte Me")).body.team;

    var res = await invite(p.ada, " Grace@Example.com ");
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.team.invites.map(function (i) { return i.email; }), ["grace@example.com"]);
    await waitFor(function () { return mail.calls.length >= 1; });
    assert.equal(mail.calls[0].to, "grace@example.com");
    assert.match(mail.calls[0].subject, /ada invited you to join Byte Me/);
    assert.match(mail.calls[0].text, /\/dashboard\/team/);

    assert.equal((await invite(p.ada, "grace@example.com")).status, 409, "already invited");
    assert.equal((await invite(p.ada, "ada@example.com")).status, 409, "already a member");
    assert.equal((await invite(p.ada, "not-an-email")).status, 400);
    assert.equal((await invite(p.linus, "barbara@example.com")).status, 404, "not on a team");

    var seen = await mine(p.grace);
    assert.equal(seen.body.team, null);
    assert.equal(seen.body.invites.length, 1);
    assert.equal(seen.body.invites[0].teamName, "Byte Me");
    assert.equal(seen.body.invites[0].invitedBy, "ada");
    assert.equal(String(seen.body.invites[0].teamId), String(team._id));
  });

  await t.test("accept joins the team and clears the invite; decline just clears it", async function (t2) {
    var p = await seed();
    mailMock.mockTransport(t2);
    var team = (await createTeam(p.ada, "Byte Me")).body.team;
    await invite(p.ada, "grace@example.com");
    await invite(p.ada, "linus@example.com");

    var joined = await accept(p.grace, team._id);
    assert.equal(joined.status, 200);
    assert.deepEqual(joined.body.team.members.map(function (m) { return m.email; }).sort(), ["ada@example.com", "grace@example.com"]);
    assert.equal(joined.body.invites.length, 0);

    var declined = await request(app).post("/api/teams/invites/" + team._id + "/decline").set(as(p.linus));
    assert.equal(declined.status, 200);
    assert.equal(declined.body.invites.length, 0);
    assert.equal((await accept(p.linus, team._id)).status, 404, "declined invite is gone");
    assert.equal((await accept(p.barbara, team._id)).status, 404, "never invited");
  });

  await t.test("you can't accept while on another team", async function (t2) {
    var p = await seed();
    mailMock.mockTransport(t2);
    var team = (await createTeam(p.ada, "Byte Me")).body.team;
    await createTeam(p.grace, "Grace's Team");
    await invite(p.ada, "grace@example.com");
    var res = await accept(p.grace, team._id);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already on a team/);
  });

  await t.test("team size counts pending invites; two people can't take the last spot", async function (t2) {
    var p = await seed(3);
    mailMock.mockTransport(t2);
    var team = (await createTeam(p.ada, "Trio")).body.team;
    assert.equal((await invite(p.ada, "grace@example.com")).status, 201);
    assert.equal((await invite(p.ada, "linus@example.com")).status, 201);
    var full = await invite(p.ada, "barbara@example.com");
    assert.equal(full.status, 400);
    assert.match(full.body.error, /full/);

    // Make room for one more invite, then race two acceptances for the last spot.
    await accept(p.grace, team._id);
    await request(app).delete("/api/teams/me/invites/linus@example.com").set(as(p.ada));
    await Team.updateOne({ _id: team._id }, { $push: { invites: { $each: [{ email: "linus@example.com" }, { email: "barbara@example.com" }] } } });
    var results = await Promise.all([accept(p.linus, team._id), accept(p.barbara, team._id)]);
    var statuses = results.map(function (r) { return r.status; }).sort();
    assert.deepEqual(statuses, [200, 400], "exactly one gets the spot");
    assert.equal((await Team.findById(team._id)).members.length, 3);
  });

  await t.test("Devpost link: any member sets it; one team per project; clearing works", async function (t2) {
    var p = await seed();
    mailMock.mockTransport(t2);
    var team = (await createTeam(p.ada, "Byte Me")).body.team;
    await invite(p.ada, "grace@example.com");
    await accept(p.grace, team._id);

    var set = await request(app).patch("/api/teams/me").set(as(p.grace)).send({ devpostUrl: "devpost.com/software/Byte-Me/" });
    assert.equal(set.status, 200);
    assert.equal(set.body.team.devpostUrl, "https://devpost.com/software/byte-me");

    var bad = await request(app).patch("/api/teams/me").set(as(p.grace)).send({ devpostUrl: "https://hackumass.devpost.com" });
    assert.equal(bad.status, 400);

    await createTeam(p.linus, "Other Team");
    var dup = await request(app).patch("/api/teams/me").set(as(p.linus)).send({ devpostUrl: "https://devpost.com/software/byte-me" });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already linked/);

    var cleared = await request(app).patch("/api/teams/me").set(as(p.ada)).send({ devpostUrl: "" });
    assert.equal(cleared.body.team.devpostUrl, "");
    var now = await request(app).patch("/api/teams/me").set(as(p.linus)).send({ devpostUrl: "https://devpost.com/software/byte-me" });
    assert.equal(now.status, 200, "free again once cleared");
  });

  await t.test("leader-only: rename and remove members", async function (t2) {
    var p = await seed();
    mailMock.mockTransport(t2);
    var team = (await createTeam(p.ada, "Byte Me")).body.team;
    await invite(p.ada, "grace@example.com");
    await accept(p.grace, team._id);

    assert.equal((await request(app).patch("/api/teams/me").set(as(p.grace)).send({ name: "Mine Now" })).status, 403);
    var renamed = await request(app).patch("/api/teams/me").set(as(p.ada)).send({ name: "Byte You" });
    assert.equal(renamed.body.team.name, "Byte You");

    var graceId = String(p.grace.user._id);
    assert.equal((await request(app).delete("/api/teams/me/members/" + String(p.ada.user._id)).set(as(p.grace))).status, 403);
    var removed = await request(app).delete("/api/teams/me/members/" + graceId).set(as(p.ada));
    assert.equal(removed.status, 200);
    assert.equal(removed.body.team.members.length, 1);
    assert.equal((await mine(p.grace)).body.team, null);
  });

  await t.test("a leaving leader hands over; the last person out deletes the team", async function (t2) {
    var p = await seed();
    mailMock.mockTransport(t2);
    var team = (await createTeam(p.ada, "Byte Me")).body.team;
    await invite(p.ada, "grace@example.com");
    await accept(p.grace, team._id);

    var left = await request(app).post("/api/teams/me/leave").set(as(p.ada));
    assert.equal(left.status, 200);
    assert.equal(left.body.team, null);
    var graceView = await mine(p.grace);
    assert.equal(graceView.body.team.leader.email, "grace@example.com", "leadership passed on");

    await request(app).post("/api/teams/me/leave").set(as(p.grace));
    assert.equal(await Team.countDocuments({}), 0);
    assert.equal((await createTeam(p.linus, "Byte Me")).status, 201, "the name is free again");
  });

  await t.test("staff see every team with members' application status; applicants can't", async function (t2) {
    var p = await seed();
    mailMock.mockTransport(t2);
    var round = await ApplicationRound.create({ name: "R", isOpen: true });
    await Application.create({ applicant: p.ada.user._id, round: round._id, status: "accepted" });
    var team = (await createTeam(p.ada, "Byte Me")).body.team;
    await invite(p.ada, "grace@example.com");
    await accept(p.grace, team._id);
    await request(app).patch("/api/teams/me").set(as(p.ada)).send({ devpostUrl: "https://devpost.com/software/byte-me" });

    var res = await request(app).get("/api/admin/teams").set(as(p.mod));
    assert.equal(res.status, 200);
    var row = res.body.teams[0];
    assert.equal(row.name, "Byte Me");
    assert.equal(row.devpostUrl, "https://devpost.com/software/byte-me");
    var byEmail = {};
    row.members.forEach(function (m) { byEmail[m.email] = m; });
    assert.equal(byEmail["ada@example.com"].leader, true);
    assert.equal(byEmail["ada@example.com"].applicationStatus, "accepted");
    assert.equal(byEmail["grace@example.com"].applicationStatus, "none");

    assert.equal((await request(app).get("/api/admin/teams").set(as(p.ada))).status, 403);
  });

  await t.test("admins set the team size (1-10)", async function () {
    var p = await seed();
    var ok = await request(app).patch("/api/admin/settings").set(as(p.admin)).send({ teamMaxSize: 5 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.settings.teamMaxSize, 5);
    assert.equal((await request(app).patch("/api/admin/settings").set(as(p.admin)).send({ teamMaxSize: 0 })).status, 400);
    assert.equal((await request(app).patch("/api/admin/settings").set(as(p.admin)).send({ teamMaxSize: 2.5 })).status, 400);
    assert.equal((await request(app).patch("/api/admin/settings").set(as(p.mod)).send({ teamMaxSize: 5 })).status, 403);
  });

  await db.closeDatabase();
});
