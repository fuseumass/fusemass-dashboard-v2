"use strict";
var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var Project = require("../schemas/project");
var Room = require("../schemas/judgingRoom");
var ProjectImport = require("../schemas/projectImport");
var Team = require("../schemas/team");
var controller = require("../controllers/adminJudgingController");
var root = "/api/admin/judging";
var header =
  "teamName,SubUrl,LeadFirst,LeadLast,projectEmail,categoryApplied,TeamMem1First,TeamMem1Last,TeamMem1Email,TeamMem1First,TeamMem1Last,TeamMem1Email,TeamMem1First,TeamMem1Last,TeamMem1Email,TeamMem1First,TeamMem1Last,TeamMem1Email,MLH,HardwareJudge";
var row =
  "Synthetic project,https://www.devpost.com/software/TEST-APP/?x=1,Test,Lead,lead@example.com,Track,Member,One,one@example.com,Member,Two,two@example.com,Member,Three,three@example.com,Member,Four,four@example.com,Track,yes";
function auth(person) {
  return { Authorization: "Bearer " + person.token };
}
function upload(person, csv) {
  return request(app)
    .post(root + "/import")
    .set(auth(person))
    .attach("file", Buffer.from(csv), "synthetic.csv");
}
function confirm(person, id, body) {
  return request(app)
    .post(root + "/import/" + id + "/confirm")
    .set(auth(person))
    .send(body || {});
}

test("CSV content validation without a database", function () {
  assert.throws(function binary() {
    controller.parseCsv(Buffer.from("\x00binary"));
  }, /UTF-8/);
  assert.throws(function json() {
    controller.parseCsv(Buffer.from('{"name":"project"}'));
  });
  assert.throws(function oversized() {
    controller.parseCsv(
      Buffer.from("teamName,SubUrl\n" + "a,b\n".repeat(2001)),
    );
  }, /2000/);
  assert.throws(function malformed() {
    controller.parseCsv(Buffer.from('teamName,SubUrl\n"unterminated'));
  });
});

test("preview matching and repeated columns without a database", async function (t) {
  var User = require("../schemas/user");
  var matchedId = "000000000000000000000001";
  var teamId = "000000000000000000000002";
  t.mock.method(User, "find", function find() {
    return {
      select: function select() {
        return {
          lean: async function lean() {
            return [{ _id: matchedId, email: "one@example.com" }];
          },
        };
      },
    };
  });
  t.mock.method(Team, "findOne", function findOne() {
    return {
      select: function select() {
        return {
          lean: async function lean() {
            return { members: [teamId] };
          },
        };
      },
    };
  });
  var projectFindOne = t.mock.method(Project, "findOne", function findOne() {
    return {
      lean: async function lean() {
        return null;
      },
    };
  });
  var stored;
  t.mock.method(ProjectImport, "create", async function create(value) {
    stored = value;
    return Object.assign({ _id: "preview-id" }, value);
  });
  var response;
  await controller.previewImport(
    {
      user: { id: matchedId },
      file: {
        buffer: Buffer.from(
          header +
            "\n" +
            row +
            "\n" +
            row.replace(
              "https://www.devpost.com/software/TEST-APP/?x=1",
              "https://invalid.example/project",
            ),
        ),
      },
    },
    {
      json: function json(value) {
        response = value;
      },
      status: function status(code) {
        assert.fail("Unexpected status " + code);
      },
    },
  );
  assert.equal(response.preview.counts.new, 1);
  assert.equal(response.preview.counts.errors, 1);
  assert.equal(response.preview.errors[0].rowNumber, 3);
  assert.deepEqual(response.preview.rows[0].project.members, [
    teamId,
    matchedId,
  ]);
  assert.deepEqual(
    response.preview.rows[0].project.unmatchedMembers.map(function email(m) {
      return m.email;
    }),
    [
      "lead@example.com",
      "two@example.com",
      "three@example.com",
      "four@example.com",
    ],
  );
  assert.equal(
    response.preview.rows[0].project.unmatchedMembers[3].name,
    "Member Four",
  );
  assert.equal(stored.createdBy, matchedId);
  assert.equal(stored.preview, response.preview);
  assert.ok(stored.expiresAt > new Date());
  var existing = Object.assign({}, response.preview.rows[0].values, {
    category: "Manual track",
    hardware: false,
    overriddenFields: ["category", "hardware"],
  });
  // Undo the first fake before installing another: node:test restores mocks
  // in creation order, so a second mock of the same method would otherwise
  // put the first fake back (not the real findOne) when this test ends.
  projectFindOne.mock.restore();
  t.mock.method(Project, "findOne", function findOne() {
    return {
      lean: async function lean() {
        return existing;
      },
    };
  });
  await controller.previewImport(
    {
      user: { id: matchedId },
      file: { buffer: Buffer.from(header + "\n" + row) },
    },
    {
      json: function json(value) {
        response = value;
      },
      status: function status(code) {
        assert.fail("Unexpected status " + code);
      },
    },
  );
  assert.equal(response.preview.counts.unchanged, 1);
  assert.equal(response.preview.rows[0].project.category, "Manual track");
  assert.equal(response.preview.rows[0].project.hardware, false);
  assert.equal(
    Object.hasOwn(response.preview.rows[0].values, "category"),
    false,
  );
});

test("judging rooms and project imports", async function (t) {
  await db.connect();
  t.after(db.closeDatabase);
  var admin = await fixtures.createUser({ role: "admin" });
  var other = await fixtures.createUser({ role: "admin" });
  var member = await fixtures.createUser({ email: "one@example.com" });
  var teammate = await fixtures.createUser({ email: "team-only@example.com" });
  await Team.create({
    name: "Synthetic team",
    nameKey: "synthetic team",
    leader: teammate.user._id,
    members: [teammate.user._id],
    devpostUrl: "https://devpost.com/software/test-app",
  });
  var id;
  await t.test(
    "cleaned repeated columns, matching, counts and exact single-use confirmation",
    async function () {
      var response = await upload(admin, header + "\n" + row);
      assert.equal(response.status, 200);
      id = response.body.id;
      var preview = response.body.preview;
      assert.deepEqual(preview.counts, {
        new: 1,
        updated: 0,
        unchanged: 0,
        errors: 0,
      });
      var p = preview.rows[0].project;
      assert.deepEqual(
        p.members.sort(),
        [String(member.user._id), String(teammate.user._id)].sort(),
      );
      assert.deepEqual(
        p.unmatchedMembers.map(function email(m) {
          return m.email;
        }),
        [
          "lead@example.com",
          "two@example.com",
          "three@example.com",
          "four@example.com",
        ],
      );
      assert.equal(p.unmatchedMembers[3].name, "Member Four");
      assert.equal(await Project.countDocuments(), 0);
      assert.equal((await confirm(other, id)).status, 409);
      assert.equal(
        (await confirm(admin, id, { rows: [{ name: "Tampered" }] })).status,
        200,
      );
      assert.equal((await Project.findOne()).name, "Synthetic project");
      assert.equal((await confirm(admin, id)).status, 409);
    },
  );
  await t.test(
    "unchanged counts, updates, table preservation, overrides including edits after preview",
    async function () {
      var preview = await upload(admin, header + "\n" + row);
      assert.equal(preview.body.preview.counts.unchanged, 1);
      var room = await Room.create({ name: "Room A", order: 0, capacity: 10 });
      var p = await Project.findOne();
      await Project.updateOne(
        { _id: p._id },
        { $set: { room: room._id, tableNumber: 1 } },
      );
      preview = await upload(
        admin,
        header + "\n" + row.replace("Synthetic project", "Updated project"),
      );
      assert.equal(preview.body.preview.counts.updated, 1);
      var patch = await request(app)
        .patch(root + "/projects/" + p._id)
        .set(auth(admin))
        .send({
          category: "Admin track",
          hardware: false,
          needsPower: true,
          withdrawn: true,
        });
      assert.equal(patch.status, 200);
      assert.equal((await confirm(admin, preview.body.id)).status, 200);
      var updated = await Project.findById(p._id);
      assert.equal(updated.name, "Updated project");
      assert.equal(updated.category, "Admin track");
      assert.equal(updated.hardware, false);
      assert.equal(updated.needsPower, true);
      assert.equal(updated.withdrawn, true);
      assert.equal(updated.tableNumber, 1);
      assert.equal(String(updated.room), String(room._id));
      assert.equal(await Project.countDocuments(), 1);
      preview = await upload(
        admin,
        header + "\n" + row.replace("Synthetic project", "Updated project"),
      );
      assert.equal(preview.body.preview.counts.unchanged, 1);
      assert.equal((await confirm(admin, preview.body.id)).status, 200);
      assert.equal(
        (
          await request(app)
            .delete(root + "/rooms/" + room._id)
            .set(auth(admin))
        ).status,
        409,
      );
      assert.equal(
        (
          await request(app)
            .get(
              root +
                "/projects?room=" +
                room._id +
                "&hardware=false&category=Admin%20track&unmatchedMembers=true",
            )
            .set(auth(admin))
        ).body.projects.length,
        1,
      );
      assert.equal(
        (
          await request(app)
            .get(root + "/projects?hardware=true")
            .set(auth(admin))
        ).body.projects.length,
        0,
      );
      await assert.rejects(
        Project.create({
          name: "Collision",
          devpostUrl: "https://devpost.com/software/collision",
          room: room._id,
          tableNumber: 1,
        }),
        { code: 11000 },
      );
    },
  );
  await t.test(
    "raw aliases, case-insensitive email matching, invalid rows and unknown headers",
    async function () {
      var csv =
        "Project Title,Submission Url,Submitter First Name,Submitter Last Name,Submitter Email,Opt-In Prizes,Team Member 1 First Name,Team Member 1 Last Name,Team Member 1 Email,Team Member 2 First Name,Team Member 2 Last Name,Team Member 2 Email,Mystery header\nRaw project,https://devpost.com/software/raw,Test,Lead,ONE@EXAMPLE.COM,Prize,Member,One,unknown@example.com,Member,Two,another@example.com,unknown\n,https://devpost.com/software/empty,,,,,,,,,,,\nBad URL,http://devpost.com/software/bad,,,,,,,,,,,";
      var response = await upload(admin, csv);
      assert.equal(response.status, 200);
      var preview = response.body.preview;
      assert.equal(preview.counts.new, 1);
      assert.equal(preview.counts.errors, 2);
      assert.deepEqual(
        preview.errors.map(function number(e) {
          return e.rowNumber;
        }),
        [3, 4],
      );
      assert.deepEqual(preview.unrecognizedColumns, ["Mystery header"]);
      assert.equal(preview.rows[0].project.members[0], String(member.user._id));
      assert.deepEqual(preview.rows[0].project.optInPrizes, ["Prize"]);
      assert.deepEqual(
        preview.rows[0].project.unmatchedMembers.map(function email(m) {
          return m.email;
        }),
        ["unknown@example.com", "another@example.com"],
      );
      await ProjectImport.updateOne(
        { _id: response.body.id },
        { $set: { expiresAt: new Date(0) } },
      );
      assert.equal((await confirm(admin, response.body.id)).status, 409);
    },
  );
  await t.test(
    "matching snapshot is frozen and concurrent confirms apply once",
    async function () {
      var response = await upload(
        admin,
        "teamName,SubUrl,projectEmail\nSnapshot,https://devpost.com/software/snapshot,later@example.com",
      );
      assert.equal(response.status, 200);
      await fixtures.createUser({ email: "later@example.com" });
      var results = await Promise.all([
        confirm(admin, response.body.id),
        confirm(admin, response.body.id),
      ]);
      assert.deepEqual(
        results
          .map(function status(r) {
            return r.status;
          })
          .sort(),
        [200, 409],
      );
      var snapshot = await Project.findOne({
        devpostUrl: "https://devpost.com/software/snapshot",
      });
      assert.equal(snapshot.members.length, 0);
      assert.equal(snapshot.unmatchedMembers[0].email, "later@example.com");
    },
  );
  await t.test(
    "room CRUD, runtime validation, duplicate rows and file limits",
    async function () {
      var create = await request(app)
        .post(root + "/rooms")
        .set(auth(admin))
        .send({ name: "Room B", order: 1, capacity: 5, hardware: true });
      assert.equal(create.status, 201);
      assert.equal(
        (
          await request(app)
            .patch(root + "/rooms/" + create.body.room._id)
            .set(auth(admin))
            .send({ capacity: 6 })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(app)
            .get(root + "/rooms")
            .set(auth(admin))
        ).body.rooms.length,
        2,
      );
      assert.equal(
        (
          await request(app)
            .delete(root + "/rooms/" + create.body.room._id)
            .set(auth(admin))
        ).status,
        200,
      );
      assert.equal(
        (
          await request(app)
            .post(root + "/rooms")
            .set(auth(admin))
            .send({ name: "Invalid", capacity: -1 })
        ).status,
        400,
      );
      assert.equal(
        (await upload(admin, header + "\n" + row + "\n" + row)).body.preview
          .counts.errors,
        1,
      );
      assert.equal((await upload(admin, "not a CSV")).status, 400);
      assert.equal(
        (await upload(admin, "x".repeat(2 * 1024 * 1024 + 1))).status,
        400,
      );
    },
  );
  await t.test(
    "all routes are admin-only and disabled judging returns 404",
    async function () {
      var moderator = await fixtures.createUser({ role: "moderator" });
      var routes = [
        ["get", "/rooms"],
        ["post", "/rooms"],
        ["patch", "/rooms/" + id],
        ["delete", "/rooms/" + id],
        ["get", "/projects"],
        ["patch", "/projects/" + id],
        ["post", "/import"],
        ["post", "/import/" + id + "/confirm"],
      ];
      for (var route of routes) {
        assert.equal(
          (await request(app)[route[0]](root + route[1])).status,
          401,
        );
        for (var person of [member, moderator])
          assert.equal(
            (
              await request(app)
                [route[0]](root + route[1])
                .set(auth(person))
            ).status,
            403,
          );
      }
      var response = await request(app)
        .patch("/api/admin/settings")
        .set(auth(admin))
        .send({ features: { judging: false } });
      assert.equal(response.status, 200);
      for (var disabled of routes)
        assert.equal(
          (
            await request(app)
              [disabled[0]](root + disabled[1])
              .set(auth(admin))
          ).status,
          404,
        );
    },
  );
});
