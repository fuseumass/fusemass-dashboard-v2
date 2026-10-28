"use strict";

require("./helpers/testEnv");
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Settings = require("../schemas/judgingSettings");
var Profile = require("../schemas/judgeProfile");
var OrgSettings = require("../schemas/orgSettings");
var computeBias = require("../utils/judging/bias").computeBias;
var rubric = require("../utils/judging/rubric");

function auth(person) {
  return "Bearer " + person.token;
}
function scores(criteria, value) {
  return Object.fromEntries(
    criteria.map(function pair(c) {
      return [c.key, value];
    }),
  );
}

test("calibration rubric rejects missing, extra, fractional, coerced and out-of-range scores", function validation() {
  var criteria = [
    { key: "general", min: 0, max: 5 },
    { key: "category", min: 0, max: 10 },
  ];
  assert.equal(
    rubric.validScores({ general: 0, category: 10 }, criteria),
    true,
  );
  for (var value of [
    null,
    [],
    {},
    { general: 1 },
    { general: 1, category: 2, extra: 3 },
    { general: 1.5, category: 2 },
    { general: "1", category: 2 },
    { general: -1, category: 2 },
    { general: 6, category: 2 },
  ]) {
    assert.equal(rubric.validScores(value, criteria), false);
  }
});

test("judging calibration API", async function suite(t) {
  await db.connect();
  t.after(async function close() {
    await db.closeDatabase();
  });
  await db.clearDatabase();
  var admin = await fixtures.createUser({ role: "admin" });
  var judge = await fixtures.createUser({ role: "judge", name: "First judge" });
  var peer = await fixtures.createUser({ role: "judge", name: "Second judge" });
  var skipped = await fixtures.createUser({
    role: "judge",
    name: "Incomplete judge",
  });
  for (var person of [judge, peer, skipped])
    await Profile.create({ user: person.user._id });
  var settings = await Settings.getSingleton();
  var criteria = settings.criteria.toObject();
  var root = "/api/admin/judging";
  var calibration = "/api/judging/calibration";
  async function submit(person, round, values, comments) {
    return request(app)
      .post(calibration + "/" + round)
      .set("Authorization", auth(person))
      .send({ scores: values, comments: comments || "" });
  }

  await t.test(
    "singleton defaults and ordered projects can be edited",
    async function defaults() {
      var response = await request(app)
        .get(root + "/settings")
        .set("Authorization", auth(admin))
        .expect(200);
      assert.equal(response.body.settings.calibrationProjects.length, 3);
      assert.deepEqual(
        response.body.settings.criteria.map(function range(c) {
          return [c.label, c.min, c.max];
        }),
        [
          ["Innovation", 0, 10],
          ["Functionality", 0, 10],
          ["Practicality", 0, 5],
          ["Presentation", 0, 10],
          ["Q&A", 0, 5],
          ["Category fit", 0, 10],
        ],
      );
      var projects = [
        {
          title: "First",
          description: "Briefing example",
          link: "https://example.com/first",
        },
        { title: "Second" },
        { title: "Third" },
      ];
      await request(app)
        .patch(root + "/settings")
        .set("Authorization", auth(admin))
        .send({ calibrationProjects: projects })
        .expect(200);
      response = await request(app)
        .get(calibration)
        .set("Authorization", auth(judge))
        .expect(200);
      assert.deepEqual(
        response.body.rounds.map(function title(p) {
          return p.title;
        }),
        ["First", "Second", "Third"],
      );
      assert.deepEqual(response.body.scores, []);
      assert.equal(response.body.calibrationDone, false);
      for (var body of [
        { calibrationProjects: [] },
        {
          calibrationProjects: [
            { title: "Bad link", link: "javascript:alert(1)" },
          ],
        },
        { criteria: [criteria[0], criteria[0]] },
        {
          criteria: criteria.map(function bad(c) {
            return Object.assign({}, c, { weight: -1 });
          }),
        },
        { judgingOpen: "true" },
      ]) {
        await request(app)
          .patch(root + "/settings")
          .set("Authorization", auth(admin))
          .send(body)
          .expect(400);
      }
    },
  );

  await t.test(
    "server validates rubric and enforces round order",
    async function validation() {
      assert.equal((await submit(judge, 3, scores(criteria, 2))).status, 409);
      for (var invalid of [
        null,
        {},
        { innovation: 2 },
        Object.assign(scores(criteria, 2), { extra: 1 }),
        Object.assign(scores(criteria, 2), { innovation: 11 }),
        Object.assign(scores(criteria, 2), { innovation: 1.5 }),
        Object.assign(scores(criteria, 2), { innovation: "2" }),
      ]) {
        assert.equal((await submit(judge, 1, invalid)).status, 400);
      }
      for (var round of [0, 4, "1.5", "invalid"])
        assert.equal(
          (await submit(judge, round, scores(criteria, 2))).status,
          400,
        );
      assert.equal(
        (await submit(judge, 1, scores(criteria, 2), 42)).status,
        400,
      );
      assert.equal((await submit(judge, 1, scores(criteria, 2))).status, 200);
      assert.equal((await submit(judge, 3, scores(criteria, 2))).status, 409);
      assert.equal(
        (await submit(judge, 2, scores(criteria, 2))).body.calibrationDone,
        false,
      );
      assert.equal(
        (await submit(judge, 3, scores(criteria, 2))).body.calibrationDone,
        true,
      );
    },
  );

  await t.test(
    "rescoring replaces a round, preserves completion and isolates judges",
    async function upsert() {
      var response = await submit(judge, 1, scores(criteria, 3), "Revised");
      assert.equal(response.status, 200);
      assert.equal(response.body.scores.length, 3);
      assert.equal(response.body.calibrationDone, true);
      var profile = await Profile.findOne({ user: judge.user._id }).lean();
      assert.equal(profile.calibrationDone, true);
      assert.equal(profile.calibrationScores[0].comments, "Revised");
      assert.deepEqual(
        profile.calibrationScores[0].scores,
        scores(criteria, 3),
      );
      response = await request(app)
        .get(calibration)
        .set("Authorization", auth(peer))
        .expect(200);
      assert.deepEqual(response.body.scores, []);
      for (var round = 1; round <= 3; round++)
        assert.equal(
          (await submit(peer, round, scores(criteria, 4))).status,
          200,
        );
      await submit(skipped, 1, scores(criteria, 0));
    },
  );

  await t.test(
    "bias uses finished judges only and matches the pure formula",
    async function bias() {
      var input = {};
      input[String(judge.user._id)] = [
        scores(criteria, 3),
        scores(criteria, 2),
        scores(criteria, 2),
      ];
      input[String(peer.user._id)] = [
        scores(criteria, 4),
        scores(criteria, 4),
        scores(criteria, 4),
      ];
      var expected = computeBias(input, {
        general: criteria
          .filter(function general(c) {
            return c.kind === "general";
          })
          .map(function key(c) {
            return c.key;
          }),
        category: "categoryFit",
      });
      var response = await request(app)
        .post(root + "/bias")
        .set("Authorization", auth(admin))
        .expect(200);
      assert.equal(response.body.judges.length, 3);
      for (var row of response.body.judges) {
        if (row.id === String(skipped.user._id)) {
          assert.equal(row.done, false);
          assert.equal(row.bias, null);
        } else {
          assert.equal(row.done, true);
          assert.equal(row.bias.general, expected[row.id].general);
          assert.equal(row.bias.category, expected[row.id].category);
          assert.ok(row.bias.computedAt);
        }
        var profile = await Profile.findOne({ user: row.id }).lean();
        assert.equal(profile.calibrationDone, row.done);
        assert.equal(
          profile.bias ? profile.bias.general : null,
          row.bias ? row.bias.general : null,
        );
      }
      var read = await request(app)
        .get(root + "/bias")
        .set("Authorization", auth(admin))
        .expect(200);
      assert.deepEqual(read.body, response.body);
      await submit(judge, 1, scores(criteria, 2));
      assert.equal(await Profile.countDocuments({ bias: { $ne: null } }), 0);
    },
  );

  await t.test(
    "scoring changes reset calibration and judging start locks criteria",
    async function locking() {
      var scored = await Profile.countDocuments({ calibrationDone: true });
      assert.ok(scored > 0);
      // Wording only: judges keep their calibration.
      var reworded = criteria.map(function relabel(c) {
        return Object.assign({}, c, { label: c.label + " (edited)", help: "New help" });
      });
      await request(app)
        .patch(root + "/settings")
        .set("Authorization", auth(admin))
        .send({ criteria: reworded })
        .expect(200);
      assert.equal(await Profile.countDocuments({ calibrationDone: true }), scored);
      // A different range makes old scores invalid: everyone starts over.
      var rescaled = reworded.map(function widen(c, i) {
        return i === 0 ? Object.assign({}, c, { max: c.max + 1 }) : c;
      });
      await request(app)
        .patch(root + "/settings")
        .set("Authorization", auth(admin))
        .send({ criteria: rescaled })
        .expect(200);
      assert.equal(await Profile.countDocuments({ calibrationDone: true }), 0);
      assert.equal(
        (await Profile.findOne({ user: judge.user._id })).calibrationScores
          .length,
        0,
      );
      await request(app)
        .patch(root + "/settings")
        .set("Authorization", auth(admin))
        .send({ judgingOpen: true })
        .expect(200);
      await request(app)
        .patch(root + "/settings")
        .set("Authorization", auth(admin))
        .send({ criteria: criteria })
        .expect(409);
      await request(app)
        .patch(root + "/settings")
        .set("Authorization", auth(admin))
        .send({ judgingOpen: false })
        .expect(200);
      await request(app)
        .patch(root + "/settings")
        .set("Authorization", auth(admin))
        .send({ criteria: criteria })
        .expect(409);
      await request(app)
        .patch(root + "/settings")
        .set("Authorization", auth(admin))
        .send({ calibrationProjects: [{ title: "Changed" }] })
        .expect(409);
    },
  );

  await t.test("permissions and feature flag", async function permissions() {
    for (var role of [null, "applicant", "moderator", "judge", "admin"]) {
      var person = role ? await fixtures.createUser({ role: role }) : null;
      for (var method of ["get", "patch"]) {
        var req = request(app)[method](root + "/settings");
        if (person) req.set("Authorization", auth(person));
        await req.send({}).expect(!role ? 401 : role === "admin" ? 200 : 403);
      }
      for (var method of ["get", "post"]) {
        var req = request(app)[method](root + "/bias");
        if (person) req.set("Authorization", auth(person));
        await req.expect(!role ? 401 : role === "admin" ? 200 : 403);
      }
      var req = request(app).get(calibration);
      if (person) req.set("Authorization", auth(person));
      await req.expect(
        !role ? 401 : ["admin", "judge"].includes(role) ? 200 : 403,
      );
      var req = request(app).post(calibration + "/1");
      if (person) req.set("Authorization", auth(person));
      // Missing rubric is rejected after the guard for judges/admins.
      await req
        .send({})
        .expect(!role ? 401 : ["admin", "judge"].includes(role) ? 400 : 403);
    }
    var org = await OrgSettings.getSingleton();
    org.features.judging = false;
    await org.save();
    for (var route of [root + "/settings", root + "/bias", calibration])
      await request(app)
        .get(route)
        .set("Authorization", auth(admin))
        .expect(404);
    await request(app)
      .post(calibration + "/1")
      .set("Authorization", auth(judge))
      .send({ scores: scores(criteria, 2) })
      .expect(404);
    await request(app)
      .post(root + "/bias")
      .set("Authorization", auth(admin))
      .expect(404);
    await request(app)
      .patch(root + "/settings")
      .set("Authorization", auth(admin))
      .send({})
      .expect(404);
    await request(app)
      .get("/api/judging")
      .set("Authorization", auth(judge))
      .expect(200);
  });
});
