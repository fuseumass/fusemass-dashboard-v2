"use strict";

// Unit tests for utils/teamProposals.js (no database).

var test = require("node:test");
var assert = require("node:assert/strict");

var tp = require("../utils/teamProposals");

function emailsOf(parsed) {
  return parsed.emails.map(function pick(e) {
    return e.email;
  });
}

function keyFor(name) {
  return String(name).trim().replace(/\s+/g, " ").toLowerCase();
}

test("parseTeammates: name - email lists with mixed separators", function () {
  var parsed = tp.parseTeammates(
    "Aarnav khanna - aarnavkhanna@umass.edu, Aryaman Goenka - aryamangoenk@umass.edu; aviral poddar - apoddar@umass.edu"
  );
  assert.deepEqual(emailsOf(parsed), ["aarnavkhanna@umass.edu", "aryamangoenk@umass.edu", "apoddar@umass.edu"]);
  assert.deepEqual(
    parsed.emails.map(function n(e) {
      return e.name;
    }),
    ["Aarnav khanna", "Aryaman Goenka", "aviral poddar"]
  );
  assert.deepEqual(parsed.names, []);
});

test("parseTeammates: parenthesised (name, email) pairs", function () {
  var parsed = tp.parseTeammates("(Isha Nayar, inayar@umass.edu), (Shamitha Theertha, stheerthapra@umass.edu)");
  assert.deepEqual(emailsOf(parsed), ["inayar@umass.edu", "stheerthapra@umass.edu"]);
  assert.equal(parsed.emails[0].name, "Isha Nayar");
  assert.equal(parsed.emails[1].name, "Shamitha Theertha");
  assert.deepEqual(parsed.names, []);
});

test("parseTeammates: hyphen glued to the name", function () {
  var parsed = tp.parseTeammates("Garv Utekar- gutekar@umass.edu");
  assert.deepEqual(parsed.emails, [{ email: "gutekar@umass.edu", name: "Garv Utekar" }]);
});

test("parseTeammates: names only are kept for staff, filler is dropped", function () {
  assert.deepEqual(tp.parseTeammates("Didy, Jeffrey, Michael").names, ["Didy", "Jeffrey", "Michael"]);
  ["forming", "N/A", "none", "Not yet, still looking", "TBD", ""].forEach(function noise(text) {
    var parsed = tp.parseTeammates(text);
    assert.deepEqual(parsed.emails, [], text);
    assert.deepEqual(parsed.names, [], text);
  });
});

test("parseTeammates: trailing sentence is ignored, the email keeps its name", function () {
  var parsed = tp.parseTeammates("Kristina Oang, kristinaoang@gmail.com, but we might need more people?");
  assert.deepEqual(parsed.emails, [{ email: "kristinaoang@gmail.com", name: "Kristina Oang" }]);
  assert.deepEqual(parsed.names, []);
});

test("parseTeammates: uppercase, angle brackets, trailing dots, 'and', email before name", function () {
  var parsed = tp.parseTeammates("JOHN.Smith+hack@Gmail.com and Jane Doe <JANE@UMASS.EDU>.");
  assert.deepEqual(emailsOf(parsed), ["john.smith+hack@gmail.com", "jane@umass.edu"]);
  assert.equal(parsed.emails[1].name, "Jane Doe");
  assert.equal(tp.parseTeammates("inayar@umass.edu Isha Nayar").emails[0].name, "Isha Nayar");
  assert.deepEqual(emailsOf(tp.parseTeammates("a@x.edu\nb@y.org\n\na@x.edu")), ["a@x.edu", "b@y.org"]);
});

test("matchKey folds Gmail aliases but not other providers", function () {
  assert.equal(tp.matchKey("John.Smith+hack@Gmail.com"), "johnsmith@gmail.com");
  assert.equal(tp.matchKey("johnsmith@googlemail.com"), "johnsmith@gmail.com");
  assert.equal(tp.matchKey("j.smith+x@umass.edu"), "j.smith+x@umass.edu");
});

test("findQuestion: by key, then by label", function () {
  var form = [
    { key: "q1", label: "Do you already have a team?", type: "select", options: ["Yes, I have a team.", "No"] },
    { key: "q2", label: "If you already have a team, please list your teammates' names and emails", type: "textarea" },
    { key: "q3", label: "Would you like to take part in our research study?", type: "select", options: ["Yes", "No"] },
  ];
  var q = tp.teamQuestions(form);
  assert.equal(q.teammates.key, "q2");
  assert.equal(q.hasTeam.key, "q1");
  assert.equal(q.research.key, "q3");
  assert.equal(q.pairing, null);
  var keyed = tp.teamQuestions([{ key: "teammates", label: "Anything", type: "text" }]);
  assert.equal(keyed.teammates.key, "teammates");
});

function app(id, email, name, fields) {
  return Object.assign(
    {
      id: id,
      userId: "u-" + id,
      email: email,
      name: name,
      status: "accepted",
      createdAt: new Date(2026, 8, Number(id.replace(/\D/g, "")) || 1),
      teammates: "",
      inScope: true,
    },
    fields || {}
  );
}

function usersFor(apps, extra) {
  return apps
    .map(function toUser(a) {
      return { id: a.userId, email: a.email, name: a.name, role: "applicant" };
    })
    .concat(extra || []);
}

test("buildProposals: connected components, mutual vs one-sided, missing accounts", function () {
  var apps = [
    app("a1", "ana@umass.edu", "Ana Lee", { teammates: "Ben Ko - ben@umass.edu, Cy Dee - CY@umass.edu" }),
    app("a2", "ben@umass.edu", "Ben Ko", { teammates: "ana@umass.edu" }),
    app("a3", "cy@umass.edu", "Cy Dee", { teammates: "dana@gmail.com" }),
    app("a4", "eve@umass.edu", "Eve Park", { teammates: "forming" }),
    app("a5", "fay@umass.edu", "Fay Wu", { teammates: "Didy, Jeffrey" }),
    app("a6", "gus@umass.edu", "Gus Hill", { teammates: "Fay Wu" }),
  ];
  var built = tp.buildProposals({
    applications: apps,
    users: usersFor(apps),
    teamByUser: {},
    invitesByKey: {},
    maxSize: 4,
    takenNames: ["team ana"],
    nameKeyFor: keyFor,
  });
  assert.equal(built.proposals.length, 2);
  var first = built.proposals[0];
  assert.deepEqual(
    first.members.map(function e(m) {
      return m.email;
    }),
    ["ana@umass.edu", "ben@umass.edu", "cy@umass.edu", "dana@gmail.com"]
  );
  assert.equal(first.leaderEmail, "ana@umass.edu");
  assert.equal(first.defaultName, "Team Ana 2", "made unique against existing names");
  assert.equal(first.links.mutual, 1, "Ana and Ben list each other");
  assert.equal(first.links.oneSided, 1, "Ana lists Cy, Cy doesn't list Ana");
  assert.deepEqual(first.flags.noApplication, ["dana@gmail.com"]);
  assert.deepEqual(first.flags.noAccount, ["dana@gmail.com"]);
  assert.equal(first.members[3].hasAccount, false);
  assert.equal(first.flags.overMax, false);

  var second = built.proposals[1];
  assert.deepEqual(
    second.members.map(function e(m) {
      return m.email;
    }),
    ["fay@umass.edu", "gus@umass.edu"],
    "a full name without an email matches the one applicant with that name"
  );
  assert.equal(second.links.byName, 1);
  assert.deepEqual(second.flags.unmatchedNames[0].names, ["Didy", "Jeffrey"]);

  var unmatchedEmails = built.unmatched.map(function e(u) {
    return u.email;
  });
  assert.deepEqual(unmatchedEmails, ["eve@umass.edu"], "'forming' is shown raw for staff");
  assert.equal(built.unmatched[0].raw, "forming");
});

test("buildProposals: Gmail alias reaches the account, out-of-scope listings don't link", function () {
  var apps = [
    app("a1", "kim@umass.edu", "Kim Ra", { teammates: "Lo.Ng+hack@gmail.com" }),
    app("a2", "long@gmail.com", "Lo Ng", { status: "pending", inScope: false, teammates: "kim@umass.edu" }),
    app("a3", "max@umass.edu", "Max Oh", { status: "pending", inScope: false, teammates: "kim@umass.edu" }),
  ];
  var built = tp.buildProposals({
    applications: apps,
    users: usersFor(apps),
    teamByUser: {},
    invitesByKey: {},
    maxSize: 4,
    takenNames: [],
    nameKeyFor: keyFor,
  });
  assert.equal(built.proposals.length, 1);
  var p = built.proposals[0];
  assert.deepEqual(
    p.members.map(function e(m) {
      return m.email;
    }),
    ["kim@umass.edu", "long@gmail.com"]
  );
  assert.equal(p.members[1].hasAccount, true, "the alias resolves to the existing account");
  assert.equal(p.links.mutual, 1, "the pending applicant's answer still confirms the link");
  assert.deepEqual(p.flags.notInScope, ["long@gmail.com"]);
});

test("buildProposals: existing teams, merge suggestion, over max size, done", function () {
  var apps = [
    app("a1", "p1@x.edu", "Pat One", { teammates: "p2@x.edu p3@x.edu p4@x.edu p5@x.edu" }),
    app("a2", "p2@x.edu", "Pat Two"),
    app("a3", "p3@x.edu", "Pat Three"),
  ];
  var team = { id: "t1", name: "Rockets", locked: false, size: 1, invites: 0 };
  var built = tp.buildProposals({
    applications: apps,
    users: usersFor(apps),
    teamByUser: { "u-a2": team },
    invitesByKey: {},
    maxSize: 4,
    takenNames: [],
    nameKeyFor: keyFor,
  });
  var p = built.proposals[0];
  assert.equal(p.flags.overMax, true);
  assert.equal(p.suggestedMergeTeamId, "t1");
  assert.equal(p.done, false);

  var doneBuilt = tp.buildProposals({
    applications: apps.slice(0, 2).map(function only(a) {
      return Object.assign({}, a, { teammates: a.id === "a1" ? "p2@x.edu" : "" });
    }),
    users: usersFor(apps),
    teamByUser: { "u-a1": team, "u-a2": team },
    invitesByKey: {},
    maxSize: 4,
    takenNames: [],
    nameKeyFor: keyFor,
  });
  assert.equal(doneBuilt.proposals[0].done, true);
});

function member(email, fields) {
  return Object.assign(
    {
      email: email,
      listedEmail: email,
      name: email.split("@")[0],
      userId: "id-" + email,
      hasAccount: true,
      role: "applicant",
      status: "accepted",
      inScope: true,
      team: null,
      invitedTo: [],
    },
    fields || {}
  );
}

test("planApply: create adds account holders, invites the rest, respects max size", function () {
  var proposal = {
    members: [
      member("a@x.edu"),
      member("b@x.edu"),
      member("c@x.edu", { hasAccount: false, userId: null, status: null, inScope: false }),
      member("d@x.edu", { team: { id: "t9", name: "Other" } }),
      member("e@x.edu", { invitedTo: [{ id: "t8", name: "Invited" }] }),
      member("f@x.edu", { status: "rejected" }),
      member("g@x.edu"),
    ],
  };
  var emails = proposal.members.map(function e(m) {
    return m.email;
  });
  var plan = tp.planApply(proposal, { memberEmails: emails, name: "", leaderEmail: "" }, { maxSize: 3 });
  assert.equal(plan.action, "create");
  assert.equal(plan.leader.email, "a@x.edu");
  assert.deepEqual(
    plan.add.map(function e(m) {
      return m.email;
    }),
    ["b@x.edu"]
  );
  assert.deepEqual(
    plan.invite.map(function e(m) {
      return m.email;
    }),
    ["c@x.edu"]
  );
  var reasons = {};
  plan.skipped.forEach(function r(s) {
    reasons[s.email] = s.reason;
  });
  assert.match(reasons["d@x.edu"], /Already on "Other"/);
  assert.match(reasons["e@x.edu"], /Already invited/);
  assert.match(reasons["f@x.edu"], /rejected/);
  assert.match(reasons["g@x.edu"], /full/);
});

test("planApply: memberEmails only narrow; requested leader honoured when able", function () {
  var proposal = { members: [member("a@x.edu"), member("b@x.edu"), member("c@x.edu")] };
  var plan = tp.planApply(
    proposal,
    { memberEmails: ["b@x.edu", "c@x.edu", "intruder@evil.com"], leaderEmail: "c@x.edu" },
    { maxSize: 4 }
  );
  assert.equal(plan.leader.email, "c@x.edu");
  assert.deepEqual(
    plan.add.map(function e(m) {
      return m.email;
    }),
    ["b@x.edu"]
  );
  assert.equal(tp.planApply(proposal, { memberEmails: ["a@x.edu"] }, { maxSize: 4 }).action, "skip");
});

test("planApply: merge invites into the existing team, skips locked or foreign teams", function () {
  var team = { id: "t1", name: "Rockets", locked: false, size: 2, invites: 1, leaderId: "x" };
  var proposal = {
    members: [member("a@x.edu", { team: { id: "t1", name: "Rockets" } }), member("b@x.edu"), member("c@x.edu")],
  };
  var all = ["a@x.edu", "b@x.edu", "c@x.edu"];
  var plan = tp.planApply(proposal, { memberEmails: all, mergeIntoTeamId: "t1" }, { maxSize: 4, mergeTeam: team });
  assert.equal(plan.action, "merge");
  assert.deepEqual(
    plan.invite.map(function e(m) {
      return m.email;
    }),
    ["b@x.edu"],
    "one seat left (2 members + 1 invite of 4)"
  );
  assert.match(plan.skipped[0].reason, /full/);

  var locked = tp.planApply(proposal, { memberEmails: all, mergeIntoTeamId: "t1" }, {
    maxSize: 4,
    mergeTeam: Object.assign({}, team, { locked: true }),
  });
  assert.equal(locked.action, "skip");
  assert.match(locked.reason, /locked/);

  var foreign = tp.planApply(proposal, { memberEmails: all, mergeIntoTeamId: "t2" }, {
    maxSize: 4,
    mergeTeam: { id: "t2", name: "Elsewhere", size: 1, invites: 0 },
  });
  assert.equal(foreign.action, "skip");
});

test("uniqueTeamName appends numbers until free", function () {
  var taken = { "team ana": true, "team ana 2": true };
  assert.equal(tp.uniqueTeamName("Team Ana", taken, keyFor), "Team Ana 3");
  assert.equal(tp.uniqueTeamName("Team Ana", taken, keyFor), "Team Ana 4");
  assert.equal(tp.defaultTeamName("ana lee"), "Team Ana");
});
