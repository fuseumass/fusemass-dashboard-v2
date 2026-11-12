"use strict";

// Duplicate handling: remove / restore (soft delete), merge two applications,
// and the possible-duplicates suggestions.

require("./helpers/testEnv");
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var mailMock = require("./helpers/mailMock");
var app = require("../server");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var EmailTemplate = require("../schemas/emailTemplate");
var HardwareCheckout = require("../schemas/hardwareCheckout");
var HardwareItem = require("../schemas/hardwareItem");
var OrgSettings = require("../schemas/orgSettings");
var Team = require("../schemas/team");
var User = require("../schemas/user");
var activeApplications = require("../utils/activeApplications");
var applicationDuplicates = require("../utils/applicationDuplicates");
var autoAccept = require("../utils/autoAccept");
var emailSegments = require("../utils/emailSegments");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

var FORM = [
  { key: "why", label: "Why?", type: "textarea" },
  { key: "track", label: "Track", type: "text" },
];

var n = 0;

/**
 * An applicant account with one application.
 * @param {object} round - ApplicationRound.
 * @param {object} extra - Application fields (name, status, phone, ...).
 * @param {object} [userExtra] - User fields (email, checkedIn, ...).
 * @returns {Promise<object>} { person, application }
 */
async function applicant(round, extra, userExtra) {
  n += 1;
  var person = await fixtures.createUser(
    Object.assign({ role: "applicant", email: "person" + n + "@school.example.com", name: "Person " + n }, userExtra || {})
  );
  var application = await Application.create(
    Object.assign(
      { applicant: person.user._id, round: round._id, name: "Person " + n, status: "pending", createdAt: new Date(Date.now() + n * 1000) },
      extra || {}
    )
  );
  return { person: person, application: application };
}

test("application duplicates", async function suite(t) {
  await db.connect();
  t.after(async function close() {
    await db.closeDatabase();
  });
  mailMock.mockTransport(t);
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();

  var admin;
  var mod;
  var plain;
  async function seedStaff() {
    admin = await fixtures.createUser({ role: "admin", name: "Ada Admin" });
    mod = await fixtures.createUser({ role: "moderator", name: "Mo Mod" });
    plain = await fixtures.createUser({ role: "applicant" });
  }
  await seedStaff();
  var round = await ApplicationRound.create({ name: "General", isOpen: true, formConfig: FORM });

  await t.test("the helper merges the rule into a filter", function helper() {
    assert.deepEqual(activeApplications.active({ status: "accepted" }), { status: "accepted", removedAt: null });
    assert.equal(activeApplications.isRemoved({ removedAt: new Date() }), true);
    assert.equal(activeApplications.isRemoved({}), false);
  });

  await t.test("remove needs a reason, restore undoes it, both are audited", async function removeRestore() {
    var a = await applicant(round, { status: "accepted" });
    var url = "/api/admin/applications/" + a.application._id;
    assert.equal((await request(app).post(url + "/remove").set(as(mod)).send({})).status, 400);
    assert.equal((await request(app).post(url + "/remove").set(as(mod)).send({ reason: "   " })).status, 400);
    assert.equal((await request(app).post(url + "/remove").set(as(plain)).send({ reason: "x" })).status, 403);

    var res = await request(app).post(url + "/remove").set(as(mod)).send({ reason: "Test application" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.application.removedAt);
    assert.equal(res.body.application.removedReason, "Test application");
    assert.equal(res.body.application.removedBy.name, "Mo Mod");
    var last = res.body.application.edits[res.body.application.edits.length - 1];
    assert.equal(last.kind, "remove");
    assert.equal(last.note, "Test application");

    // The document and the account are still there.
    assert.ok(await Application.findById(a.application._id));
    assert.ok(await User.findById(a.person.user._id));

    // Twice: second click is refused, one audit entry.
    assert.equal((await request(app).post(url + "/remove").set(as(mod)).send({ reason: "Again" })).status, 409);
    assert.equal((await Application.findById(a.application._id)).edits.length, 1);

    // Can't be decided while removed.
    assert.equal((await request(app).patch(url).set(as(mod)).send({ decision: "rejected" })).status, 409);

    res = await request(app).post(url + "/restore").set(as(admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.application.removedAt, null);
    assert.equal(res.body.application.removedReason, undefined);
    assert.deepEqual(
      res.body.application.edits.map(function kind(e) {
        return e.kind;
      }),
      ["remove", "restore"]
    );
    assert.equal((await request(app).post(url + "/restore").set(as(admin))).status, 409);
  });

  await t.test("review list hides removed unless asked", async function list() {
    var a = await applicant(round, { name: "Listed Person" });
    var b = await applicant(round, { name: "Removed Person" });
    await request(app).post("/api/admin/applications/" + b.application._id + "/remove").set(as(mod)).send({ reason: "Test application" });
    var res = await request(app).get("/api/admin/applications").set(as(mod));
    var names = res.body.applications.map(function name(x) {
      return x.name;
    });
    assert.ok(names.indexOf("Listed Person") !== -1);
    assert.equal(names.indexOf("Removed Person"), -1);
    assert.ok(res.body.removedCount >= 1);
    res = await request(app).get("/api/admin/applications?removed=true").set(as(mod));
    var row = res.body.applications.find(function find(x) {
      return x.name === "Removed Person";
    });
    assert.ok(row && row.removedAt);
    assert.ok(a);
  });

  await t.test("removed applications are excluded everywhere an application counts", async function exclusion() {
    await db.clearDatabase();
    await EmailTemplate.seedDefaults();
    await seedStaff();
    var staff = admin;
    var staffMod = mod;
    var r = await ApplicationRound.create({ name: "General", isOpen: true, formConfig: FORM });
    var keep = await applicant(r, { status: "accepted", name: "Keep Person", university: "UMass" }, { checkedIn: true });
    var gone = await applicant(
      r,
      { status: "accepted", name: "Gone Person", university: "UMass", resumeBlobName: "x.pdf" },
      { email: "gone@umass.edu" }
    );
    var pend = await applicant(r, { status: "pending", name: "Pending Person" }, { email: "pending@umass.edu" });
    await Application.updateOne({ _id: gone.application._id }, { removedAt: new Date(), removedReason: "Test application" });

    // Stats.
    var stats = (await request(app).get("/api/admin/stats").set(as(staff))).body;
    assert.equal(stats.applications.total, 2, "removed one is not counted");
    assert.equal(stats.applications.byStatus.accepted, 1);
    assert.equal(stats.applications.byRound[0].byStatus.accepted, 1);
    assert.equal(stats.applications.bySchool.total, 2);

    // Export.
    var csv = (await request(app).get("/api/admin/exports/applications.csv").set(as(staff))).text;
    assert.ok(csv.indexOf("Keep Person") !== -1);
    assert.equal(csv.indexOf("Gone Person"), -1);

    // User groups.
    var groups = (await request(app).get("/api/admin/groups").query({ round: String(r._id) }).set(as(staff))).body;
    assert.equal(groups.total, 2);
    var options = (await request(app).get("/api/admin/groups/options").query({ round: String(r._id) }).set(as(staff))).body;
    assert.equal(options.statuses.accepted, 1);

    // Email segments.
    var seg = await emailSegments.resolve(emailSegments.find("accepted"), {});
    assert.deepEqual(
      seg.map(function email(x) {
        return x.email;
      }),
      [keep.person.user.email]
    );

    // "Haven't applied" still treats them as someone who applied.
    var notApplied = await emailSegments.resolve(emailSegments.find("not_applied"), {});
    assert.equal(
      notApplied.some(function has(x) {
        return x.email === "gone@umass.edu";
      }),
      false
    );

    // Auto-accept candidates.
    var preview = await autoAccept.preview({ domains: ["umass.edu"], includeSubdomains: true });
    assert.equal(preview.pending, 1, "only the active pending one");
    await Application.updateOne({ _id: pend.application._id }, { removedAt: new Date() });
    preview = await autoAccept.preview({ domains: ["umass.edu"], includeSubdomains: true });
    assert.equal(preview.pending, 0, "a removed pending one is not auto-accepted");
    await Application.updateOne({ _id: pend.application._id }, { removedAt: null });

    // Check-in eligibility: an accepted-but-removed application is not accepted.
    var checkin = await request(app).post("/api/staff/checkin").set(as(staffMod)).send({ userId: String(gone.person.user._id) });
    assert.equal(checkin.status, 400, JSON.stringify(checkin.body));
    assert.match(checkin.body.error, /removed/);
    assert.equal(checkin.body.code, "not_accepted");
    var stat = (await request(app).get("/api/staff/checkin/stats").set(as(staffMod))).body;
    assert.equal(stat.accepted, 1);
    var search = (await request(app).get("/api/staff/attendees").query({ q: "Gone" }).set(as(staffMod))).body;
    assert.equal(JSON.stringify(search).indexOf("Gone Person"), -1);

    // Workshop and hardware eligibility (accepted participants only).
    var workshops = await request(app).get("/api/workshops").set(as(gone.person));
    assert.equal(workshops.status, 403);
    assert.equal((await request(app).get("/api/workshops").set(as(keep.person))).status, 200);
    var hardware = await request(app).get("/api/hardware").set(as(gone.person));
    assert.equal(hardware.status, 400);

    // The applicant's own view: withdrawn by the organizers.
    var mine = (await request(app).get("/api/applications/me").set(as(gone.person))).body;
    assert.equal(mine.application.removedAt !== null, true);
    assert.equal(mine.application.removedReason, undefined, "reason stays private");
    assert.equal(mine.latest.application.status, "removed");
    var apply = await request(app).post("/api/applications").set(as(gone.person)).send({ name: "Gone Person", answers: "{}" });
    assert.equal(apply.status, 403);
    assert.equal((await request(app).get("/api/applications/me/qr").set(as(gone.person))).status, 404);

    // Team builder: unteamed accepted list.
    var unteamed = (await request(app).get("/api/admin/team-builder/unteamed").query({ round: String(r._id) }).set(as(staff))).body;
    assert.equal(unteamed.total, 1);
    var proposals = await request(app).get("/api/admin/team-builder/proposals").query({ round: String(r._id) }).set(as(staff));
    assert.equal(proposals.status, 200);
    assert.equal(proposals.body.counts.inScope, 1);

    // Setup reminders candidates.
    var reminders = require("../utils/setupReminders");
    var cands = await reminders.findCandidates();
    assert.equal(
      cands.eligible.some(function has(u) {
        return String(u._id) === String(gone.person.user._id);
      }),
      false
    );
    assert.ok(OrgSettings);

    // Later tests use a fresh round.
    round = await ApplicationRound.create({ name: "After", isOpen: true, formConfig: FORM });
  });

  await t.test("merge: kept application takes chosen fields, the other is removed, both audited", async function merge() {
    var older = await applicant(round, {
      name: "Jordan Lee",
      university: "UMass",
      phone: "",
      status: "pending",
      answers: { why: "Older why", track: "" },
      socials: { github: "https://github.com/old" },
    });
    var newer = await applicant(round, {
      name: "Jordan Q. Lee",
      university: "Smith",
      phone: "(413) 555-0100",
      status: "pending",
      answers: { why: "Newer why", track: "Hardware" },
      programmingSkills: ["Go"],
    });
    var url = "/api/admin/applications/" + older.application._id;

    var cmp = await request(app).get(url + "/compare").query({ otherId: String(newer.application._id) }).set(as(mod));
    assert.equal(cmp.status, 200, JSON.stringify(cmp.body));
    assert.equal(cmp.body.defaultKeep, "this", "older one by default");
    assert.ok(cmp.body.fields.indexOf("answers.why") !== -1);

    // Validation.
    var bad = await request(app).post(url + "/merge").set(as(mod)).send({ otherId: String(older.application._id), keep: "this" });
    assert.equal(bad.status, 400);
    bad = await request(app).post(url + "/merge").set(as(mod)).send({ otherId: String(newer.application._id), keep: "both" });
    assert.equal(bad.status, 400);
    bad = await request(app)
      .post(url + "/merge")
      .set(as(mod))
      .send({ otherId: String(newer.application._id), keep: "this", fields: { status: "other" } });
    assert.equal(bad.status, 400, "status cannot be merged");

    var body = { otherId: String(newer.application._id), keep: "this", fields: { university: "other", "answers.why": "other" } };
    var res = await request(app).post(url + "/merge").set(as(mod)).send(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    var kept = res.body.application;
    assert.equal(kept._id, String(older.application._id));
    assert.equal(kept.name, "Jordan Lee", "default keeps its own value");
    assert.equal(kept.university, "Smith", "chosen from the other");
    assert.equal(kept.phone, "(413) 555-0100", "blank filled from the other");
    assert.equal(kept.answers.why, "Newer why");
    assert.equal(kept.answers.track, "Hardware", "blank answer filled");
    assert.deepEqual(kept.programmingSkills, ["Go"]);
    assert.equal(kept.socials.github, "https://github.com/old");
    assert.equal(kept.edits[kept.edits.length - 1].kind, "merge");
    assert.ok(kept.edits[kept.edits.length - 1].fields.indexOf("university (from the other application)") !== -1);
    assert.equal((await Application.findById(older.application._id)).phoneKey, "4135550100");

    var removed = await Application.findById(newer.application._id);
    assert.ok(removed.removedAt);
    assert.equal(String(removed.duplicateOf), String(older.application._id));
    assert.match(removed.removedReason, /^Merged into Jordan Lee/);
    assert.equal(removed.edits[removed.edits.length - 1].kind, "merge");
    assert.equal(String(removed.edits[removed.edits.length - 1].other), String(older.application._id));
    // Accounts are left alone.
    assert.ok(await User.findById(newer.person.user._id));

    // Double submit: the second merge cannot happen.
    var again = await request(app).post(url + "/merge").set(as(mod)).send(body);
    assert.equal(again.status, 409);
    assert.equal((await Application.findById(older.application._id)).edits.filter(function m(e) {
      return e.kind === "merge";
    }).length, 1);

    // Concurrent double click: exactly one wins.
    var x = await applicant(round, { name: "Concurrent Pat" });
    var y = await applicant(round, { name: "Concurrent Pat Two" });
    var send = function sendMerge() {
      return request(app)
        .post("/api/admin/applications/" + x.application._id + "/merge")
        .set(as(mod))
        .send({ otherId: String(y.application._id), keep: "this" });
    };
    var both = await Promise.all([send(), send()]);
    var codes = both.map(function code(r) {
      return r.status;
    }).sort();
    assert.deepEqual(codes, [200, 409]);
  });

  await t.test("merge warns about what is attached to the removed account and can keep the other", async function warnings() {
    var a = await applicant(round, { name: "Casey Kim", status: "pending" });
    var b = await applicant(round, { name: "Casey Kim", status: "accepted" });
    var team = await Team.create({
      name: "Team Casey",
      nameKey: "team casey",
      leader: a.person.user._id,
      members: [a.person.user._id],
    });
    var item = await HardwareItem.create({ name: "Board", totalQty: 3, availableQty: 2 });
    await HardwareCheckout.create({
      user: a.person.user._id,
      item: item._id,
      checkedOutBy: admin.user._id,
      slot: 1,
    });
    var url = "/api/admin/applications/" + a.application._id;
    var cmp = await request(app).get(url + "/compare").query({ otherId: String(b.application._id) }).set(as(mod));
    assert.equal(cmp.body.defaultKeep, "other", "accepted one by default");
    assert.equal(cmp.body["this"].attachments.team.name, "Team Casey");
    assert.equal(cmp.body["this"].attachments.hardwareLoans, 1);
    assert.equal(cmp.body["this"].attachments.hardwareLoansOpen, 1);

    var res = await request(app).post(url + "/merge").set(as(mod)).send({ otherId: String(b.application._id), keep: "other" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.application._id, String(b.application._id));
    var text = res.body.warnings.join(" ");
    assert.match(text, /team Team Casey/);
    assert.match(text, /1 hardware loan \(1 not returned yet\)/);
    assert.ok(await Team.findById(team._id), "the team is untouched");
    assert.equal(
      (await HardwareCheckout.findOne({ user: a.person.user._id })).returnedAt,
      null,
      "loans are not moved or closed"
    );
  });

  await t.test("both accepted and both checked in: refused unless an admin confirms", async function bothCheckedIn() {
    var a = await applicant(round, { name: "Both In", status: "accepted" }, { checkedIn: true });
    var b = await applicant(round, { name: "Both In Too", status: "accepted" }, { checkedIn: true });
    var url = "/api/admin/applications/" + a.application._id;
    var body = { otherId: String(b.application._id), keep: "this" };
    var res = await request(app).post(url + "/merge").set(as(mod)).send(body);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "both_checked_in");
    res = await request(app).post(url + "/merge").set(as(mod)).send(Object.assign({ confirmBothCheckedIn: true }, body));
    assert.equal(res.status, 409, "a moderator cannot confirm");
    res = await request(app).post(url + "/merge").set(as(admin)).send(Object.assign({ confirmBothCheckedIn: true }, body));
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  await t.test("a removed application cannot be merged", async function mergeRemoved() {
    var a = await applicant(round, { name: "Live One" });
    var b = await applicant(round, { name: "Dead One", removedAt: new Date() });
    var res = await request(app)
      .post("/api/admin/applications/" + a.application._id + "/merge")
      .set(as(mod))
      .send({ otherId: String(b.application._id), keep: "this" });
    assert.equal(res.status, 409);
  });

  await t.test("suggestions: phone, name, gmail alias, with dismiss", async function suggestions() {
    await db.clearDatabase();
    await seedStaff();
    var r = await ApplicationRound.create({ name: "Dupes", isOpen: true, formConfig: FORM });
    var p1 = await applicant(r, { name: "Alpha One", phone: "(413) 555-0111" });
    var p2 = await applicant(r, { name: "Totally Different", phone: "+1 413.555.0111" });
    var n1 = await applicant(r, { name: "José  Núñez" });
    var n2 = await applicant(r, { name: "jose nunez" });
    var g1 = await applicant(r, { name: "Gee One" }, { email: "j.doe+hack@gmail.com" });
    var g2 = await applicant(r, { name: "Gee Two" }, { email: "jdoe@googlemail.com" });
    var solo = await applicant(r, { name: "Solo Person", phone: "413 555 9999" });
    var removedDupe = await applicant(r, { name: "Jose Nunez", removedAt: new Date() });
    var draft = await applicant(r, { name: "Jose Nunez", status: "draft" });
    var admins = mod;

    var res = await request(app).get("/api/admin/applications/duplicates").query({ round: String(r._id) }).set(as(admins));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    var groups = res.body.groups.map(function ids(g) {
      return {
        ids: g.applications.map(function id(a) {
          return String(a._id);
        }).sort(),
        reasons: g.reasons,
      };
    });
    assert.equal(groups.length, 3);
    function find(a, b) {
      return groups.find(function has(g) {
        return g.ids.indexOf(String(a.application._id)) !== -1 && g.ids.indexOf(String(b.application._id)) !== -1;
      });
    }
    assert.deepEqual(find(p1, p2).reasons, ["phone"]);
    assert.deepEqual(find(n1, n2).reasons, ["name"]);
    assert.equal(find(n1, n2).ids.length, 2, "removed and draft ones are not suggested");
    assert.deepEqual(find(g1, g2).reasons, ["email"]);
    assert.equal(
      groups.some(function hasSolo(g) {
        return g.ids.indexOf(String(solo.application._id)) !== -1;
      }),
      false
    );
    assert.ok(removedDupe && draft);

    // Dismiss one pair, in the other order: it stays gone.
    var dismiss = await request(app)
      .post("/api/admin/applications/duplicates/dismiss")
      .set(as(admins))
      .send({ ids: [String(p2.application._id), String(p1.application._id)] });
    assert.equal(dismiss.status, 200);
    res = await request(app).get("/api/admin/applications/duplicates").query({ round: String(r._id) }).set(as(admins));
    assert.equal(res.body.groups.length, 2);
    assert.equal((await request(app).post("/api/admin/applications/duplicates/dismiss").set(as(admins)).send({ ids: ["x"] })).status, 400);

    // Search for the other half of a merge.
    var search = await request(app).get("/api/admin/applications/search").query({ q: "nunez" }).set(as(admins));
    assert.equal(search.status, 200);
    assert.equal(search.body.applications.length, 1, "removed and draft ones are not offered");
    assert.equal(search.body.applications[0].name, "jose nunez");
  });

  await t.test("normalizers", function normalizers() {
    assert.equal(applicationDuplicates.nameKey("  José   NÚÑEZ "), "jose nunez");
    assert.equal(applicationDuplicates.nameKey("Sam"), "", "one word is too common");
    assert.equal(applicationDuplicates.gmailKey("J.Doe+x@Gmail.com"), "jdoe@gmail.com");
    assert.equal(applicationDuplicates.gmailKey("j.doe@school.edu"), "");
  });

  await t.test("permissions: applicants cannot reach any of it", async function permissions() {
    var a = await applicant(round, {});
    var base = "/api/admin/applications/";
    var checks = [
      request(app).post(base + a.application._id + "/remove").send({ reason: "x" }),
      request(app).post(base + a.application._id + "/restore"),
      request(app).get(base + a.application._id + "/compare"),
      request(app).post(base + a.application._id + "/merge").send({ otherId: String(a.application._id), keep: "this" }),
      request(app).get(base + "duplicates"),
      request(app).get(base + "search"),
    ];
    for (var i = 0; i < checks.length; i += 1) {
      assert.equal((await checks[i].set(as(plain))).status, 403);
    }
    assert.equal((await request(app).get(base + "duplicates")).status, 401);
  });
});
