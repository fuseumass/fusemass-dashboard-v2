"use strict";

// Technical settings: GET/PATCH /api/admin/system-config and the restart route.

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var systemConfig = require("../utils/systemConfig");
var SystemSetting = require("../schemas/systemSetting");

var URL_PATH = "/api/admin/system-config";

/**
 * @param {object} body - A GET/PATCH response body.
 * @param {string} key - Env var name.
 * @returns {object}
 */
function find(body, key) {
  return body.settings.find(function match(s) {
    return s.key === key;
  });
}

test("Technical settings", async function technicalSettings(t) {
  await db.connect();
  await db.clearDatabase();

  var admin = await fixtures.createUser({ role: "admin" });
  var moderator = await fixtures.createUser({ role: "moderator" });
  var applicant = await fixtures.createUser({ role: "applicant" });
  var savedEnv = {
    ORG_NAME: process.env.ORG_NAME,
    ALLOW_SELF_RESTART: process.env.ALLOW_SELF_RESTART,
  };

  /**
   * @param {string} method - HTTP method.
   * @param {string} path - Path.
   * @param {object} [who] - A fixture user; none sends no token.
   * @returns {object} A supertest request.
   */
  function call(method, path, who) {
    var req = request(app)[method](path);
    return who ? req.set("Authorization", "Bearer " + who.token) : req;
  }

  t.after(async function cleanup() {
    Object.keys(savedEnv).forEach(function restore(key) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    });
    await db.closeDatabase();
  });

  await t.test("only admins may read or change settings", async function () {
    for (var who of [null, applicant, moderator]) {
      var want = who ? 403 : 401;
      assert.equal((await call("get", URL_PATH, who)).status, want);
      assert.equal((await call("patch", URL_PATH, who).send({ values: { ORG_NAME: "x" } })).status, want);
      assert.equal((await call("post", URL_PATH + "/restart", who)).status, want);
    }
    assert.equal(await SystemSetting.countDocuments({}), 0);
  });

  await t.test("lists every setting with its source and no secret values", async function () {
    var res = await call("get", URL_PATH, admin);
    assert.equal(res.status, 200);
    assert.ok(res.body.groups.indexOf("Email") !== -1);
    assert.equal(res.body.selfRestart, false);

    var jwt = find(res.body, "JWT_SECRET");
    assert.equal(jwt.editable, false);
    assert.equal(jwt.secret, true);
    assert.equal(jwt.value, undefined);
    assert.equal(jwt.hint, undefined);
    assert.equal(jwt.isSet, true);
    assert.equal(res.text.indexOf(process.env.JWT_SECRET), -1);
    assert.equal(res.text.indexOf(process.env.SMTP_PASS), -1);

    var org = find(res.body, "ORG_NAME");
    assert.equal(org.source, "env");
    assert.equal(org.value, "Test Org");

    ["MONGODB_URI", "PORT", "JWT_SECRET", "SETUP_ADMIN", "NODE_ENV"].forEach(function readOnly(key) {
      assert.equal(find(res.body, key).editable, false, key);
    });
    assert.equal(find(res.body, "GOOGLE_CLIENT_SECRET").restartRequired, true);
    assert.equal(find(res.body, "SMTP_HOST").restartRequired, false);
  });

  await t.test("a save with any invalid value saves nothing", async function () {
    var res = await call("patch", URL_PATH, admin).send({
      values: { ORG_NAME: "Should not stick", SMTP_PORT: "99999", ORG_WEBSITE_URL: "not a url" },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.SMTP_PORT);
    assert.ok(res.body.errors.ORG_WEBSITE_URL);
    assert.equal(res.body.errors.ORG_NAME, undefined);
    assert.equal(await SystemSetting.countDocuments({}), 0);
    assert.equal(process.env.ORG_NAME, "Test Org");
  });

  await t.test("unknown and read-only keys are refused", async function () {
    for (var key of ["JWT_SECRET", "MONGODB_URI", "PORT", "SETUP_ADMIN", "NODE_ENV", "CONFIG_ENCRYPTION_KEY", "ALLOW_SELF_RESTART", "JWT_EXPIRES_IN", "CLIENT_ORIGIN", "TRUST_PROXY", "NOT_A_SETTING"]) {
      var res = await call("patch", URL_PATH, admin).send({ values: { [key]: "x" } });
      assert.equal(res.status, 400, key);
      assert.ok(res.body.errors[key], key);
    }
    var empty = await call("patch", URL_PATH, admin).send({ values: {} });
    assert.equal(empty.status, 400);
    assert.equal(await SystemSetting.countDocuments({}), 0);
  });

  await t.test("changing a value applies it at once, and null resets it to .env", async function () {
    var res = await call("patch", URL_PATH, admin).send({ values: { ORG_NAME: "Dashboard Org" } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.changed, ["ORG_NAME"]);
    assert.deepEqual(res.body.restartRequired, []);
    assert.equal(process.env.ORG_NAME, "Dashboard Org");
    assert.equal(find(res.body, "ORG_NAME").source, "dashboard");

    var again = await call("get", URL_PATH, admin);
    assert.equal(find(again.body, "ORG_NAME").value, "Dashboard Org");

    var reset = await call("patch", URL_PATH, admin).send({ values: { ORG_NAME: null } });
    assert.equal(reset.status, 200);
    assert.equal(process.env.ORG_NAME, "Test Org");
    assert.equal(find(reset.body, "ORG_NAME").source, "env");
    assert.equal(await SystemSetting.countDocuments({ key: "ORG_NAME" }), 0);
  });

  await t.test("secrets are encrypted at rest and never returned", async function () {
    var plain = "very-secret-value-0123456789";
    var res = await call("patch", URL_PATH, admin).send({ values: { GOOGLE_CLIENT_SECRET: plain } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.restartRequired, ["GOOGLE_CLIENT_SECRET"]);
    assert.equal(res.text.indexOf(plain), -1);

    var stored = await SystemSetting.findOne({ key: "GOOGLE_CLIENT_SECRET" }).lean();
    assert.equal(stored.encrypted, true);
    assert.notEqual(stored.value, plain);
    assert.equal(stored.value.indexOf(plain), -1);
    assert.equal(systemConfig.decrypt("GOOGLE_CLIENT_SECRET", stored.value), plain);
    // Bound to its key: moving the ciphertext to another key does not decrypt.
    assert.throws(function () {
      systemConfig.decrypt("SMTP_PASS", stored.value);
    });
    assert.equal(String(stored.updatedBy), String(admin.user._id));

    var list = await call("get", URL_PATH, admin);
    var entry = find(list.body, "GOOGLE_CLIENT_SECRET");
    assert.equal(entry.isSet, true);
    assert.equal(entry.hint, plain.slice(-4));
    assert.equal(entry.value, undefined);
    assert.equal(list.text.indexOf(plain), -1);

    await call("patch", URL_PATH, admin).send({ values: { GOOGLE_CLIENT_SECRET: null } });
    assert.equal(process.env.GOOGLE_CLIENT_SECRET, undefined);
  });

  await t.test("short secrets show no hint", async function () {
    await call("patch", URL_PATH, admin).send({ values: { SMTP_PASS: "short" } });
    var list = await call("get", URL_PATH, admin);
    assert.equal(find(list.body, "SMTP_PASS").hint, undefined);
    await call("patch", URL_PATH, admin).send({ values: { SMTP_PASS: null } });
  });

  await t.test("CLIENT_ORIGIN must keep the address the admin is using", async function () {
    var res = await call("patch", URL_PATH, admin)
      .set("Origin", "http://localhost:3000")
      .send({ values: { CLIENT_ORIGIN: "https://elsewhere.example.com" } });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.CLIENT_ORIGIN);
    assert.equal(process.env.CLIENT_ORIGIN, "http://localhost:3000");
  });

  await t.test("saved overrides load into process.env on startup", async function () {
    await SystemSetting.deleteMany({});
    await SystemSetting.create({ key: "ORG_NAME", value: "From the database" });
    await SystemSetting.create({
      key: "SMTP_PASS",
      value: systemConfig.encrypt("SMTP_PASS", "loaded-secret-0123456789"),
      encrypted: true,
    });
    // A read-only key in the database is never applied.
    await SystemSetting.create({ key: "JWT_SECRET", value: "attacker-secret" });
    var jwtBefore = process.env.JWT_SECRET;
    var passBefore = process.env.SMTP_PASS;

    var applied = await systemConfig.loadOverrides();
    assert.equal(applied, 2);
    assert.equal(process.env.ORG_NAME, "From the database");
    assert.equal(process.env.SMTP_PASS, "loaded-secret-0123456789");
    assert.equal(process.env.JWT_SECRET, jwtBefore);

    // Reset still goes back to the original .env values.
    var reset = await call("patch", URL_PATH, admin).send({ values: { ORG_NAME: null, SMTP_PASS: null } });
    assert.equal(reset.status, 200);
    assert.equal(process.env.ORG_NAME, "Test Org");
    assert.equal(process.env.SMTP_PASS, passBefore);
  });

  await t.test("restart is refused unless ALLOW_SELF_RESTART is true", async function () {
    delete process.env.ALLOW_SELF_RESTART;
    var exits = [];
    systemConfig.setRestartHooks({
      exit: function fakeExit(code) {
        exits.push(code);
      },
      delayMs: 10,
      forceAfterMs: 20,
    });

    var refused = await call("post", URL_PATH + "/restart", admin);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /by hand/);
    await new Promise(function wait(r) {
      setTimeout(r, 80);
    });
    assert.deepEqual(exits, []);

    process.env.ALLOW_SELF_RESTART = "true";
    var accepted = await call("post", URL_PATH + "/restart", admin);
    assert.equal(accepted.status, 202);
    assert.deepEqual(accepted.body, { restarting: true });
    await new Promise(function wait(r) {
      setTimeout(r, 120);
    });
    assert.deepEqual(exits, [0]);
  });

  await t.test("restart is rate limited", async function () {
    process.env.ALLOW_SELF_RESTART = "false";
    var last;
    for (var i = 0; i < 5; i++) {
      last = await call("post", URL_PATH + "/restart", admin);
    }
    assert.equal(last.status, 429);
  });

});

// These checks run without MongoDB: node --test --test-name-pattern="config unit" test/systemConfig.test.js

test("config unit: registry covers backend environment reads", function () {
  var fs = require("node:fs");
  var path = require("node:path");
  function scan(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function visit(entry) {
      if (["test", "node_modules"].indexOf(entry.name) !== -1) return;
      var name = path.join(dir, entry.name);
      if (entry.isDirectory()) return scan(name);
      if (!name.endsWith(".js")) return;
      var source = fs.readFileSync(name, "utf8");
      var matches = source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g);
      for (var match of matches) assert.ok(systemConfig.getDef(match[1]), match[1]);
    });
  }
  scan(require("node:path").join(__dirname, ".."));
  systemConfig.REGISTRY.forEach(function check(item) {
    assert.equal(typeof item.validate, "function", item.key);
  });
});

test("config unit: invalid batches and prototype keys never write", async function (t) {
  t.mock.method(SystemSetting, "updateOne", function unexpected() { assert.fail("unexpected write"); });
  t.mock.method(SystemSetting, "deleteOne", function unexpected() { assert.fail("unexpected delete"); });
  for (var key of ["CLIENT_ORIGIN", "TRUST_PROXY", "JWT_SECRET", "CONFIG_ENCRYPTION_KEY", "__proto__", "constructor"]) {
    var values = JSON.parse('{"ORG_NAME":"Valid","' + key + '":null}');
    var result = await systemConfig.applyChanges(values, null);
    assert.ok(result.errors[key], key);
  }
  var invalid = await systemConfig.applyChanges({ ORG_NAME: "Valid", SMTP_PORT: false }, null);
  assert.ok(invalid.errors.SMTP_PORT);
});

test("config unit: encryption failure happens before any write", async function (t) {
  var jwt = process.env.JWT_SECRET;
  var encryption = process.env.CONFIG_ENCRYPTION_KEY;
  delete process.env.JWT_SECRET;
  delete process.env.CONFIG_ENCRYPTION_KEY;
  t.after(function restore() {
    if (jwt !== undefined) process.env.JWT_SECRET = jwt;
    if (encryption !== undefined) process.env.CONFIG_ENCRYPTION_KEY = encryption;
  });
  t.mock.method(SystemSetting, "findOne", function unexpected() { assert.fail("unexpected database access"); });
  await assert.rejects(systemConfig.applyChanges({ ORG_NAME: "Valid", SMTP_PASS: "secret-value" }, null), /encrypt/);
});

test("config unit: secrets retain spaces and never serialize from the model", function () {
  var checked = systemConfig.validateValue(systemConfig.getDef("SMTP_PASS"), "  secret  ");
  assert.equal(checked.value, "  secret  ");
  var doc = new SystemSetting({ key: "SMTP_PASS", value: "private-value", encrypted: true });
  assert.equal(JSON.stringify(doc).includes("private-value"), false);
});

test("config unit: controller errors never forward driver secrets", async function () {
  var controller = require("../controllers/systemConfigController");
  var original = systemConfig.applyChanges;
  systemConfig.applyChanges = function fail() { return Promise.reject(new Error("private-driver-value")); };
  var body;
  var res = {
    set: function set() {},
    status: function status(code) { assert.equal(code, 500); return res; },
    json: function json(value) { body = value; },
  };
  try {
    await controller.updateSystemConfig({ body: { values: { SMTP_PASS: "secret" } }, user: {}, get: function get() {} }, res,
      function next() { assert.fail("must not forward driver error"); });
    assert.equal(JSON.stringify(body).includes("private-driver-value"), false);
  } finally { systemConfig.applyChanges = original; }
});

test("config unit: restart uses injected exit exactly once", async function () {
  var exits = [];
  systemConfig.setRestartHooks({ exit: function fake(code) { exits.push(code); }, delayMs: 1, forceAfterMs: 10 });
  systemConfig.scheduleRestart();
  await new Promise(function wait(resolve) { setTimeout(resolve, 30); });
  assert.deepEqual(exits, [0]);
});


test("config unit: authenticated encryption binds secrets to their setting", function () {
  var plain = "regression-secret-with-spaces ";
  var stored = systemConfig.encrypt("SMTP_PASS", plain);
  assert.equal(stored.includes(plain), false);
  assert.equal(systemConfig.decrypt("SMTP_PASS", stored), plain);
  assert.throws(function moved() { systemConfig.decrypt("GOOGLE_CLIENT_SECRET", stored); });
  var parts = stored.split(":");
  var cipher = Buffer.from(parts[3], "base64");
  cipher[0] ^= 1;
  parts[3] = cipher.toString("base64");
  assert.throws(function tampered() { systemConfig.decrypt("SMTP_PASS", parts.join(":")); });
});

test("config unit: page model redacts secrets and preserves empty overrides", async function (t) {
  var original = process.env.SMTP_PASS;
  var org = process.env.ORG_NAME;
  process.env.SMTP_PASS = "regression-secret-123456789";
  process.env.ORG_NAME = "";
  t.after(function restore() {
    if (original === undefined) delete process.env.SMTP_PASS; else process.env.SMTP_PASS = original;
    if (org === undefined) delete process.env.ORG_NAME; else process.env.ORG_NAME = org;
  });
  t.mock.method(SystemSetting, "find", function fake() {
    return { select: function select() { return { lean: function lean() { return Promise.resolve([{ key: "SMTP_PASS" }, { key: "ORG_NAME" }]); } }; } };
  });
  var model = await systemConfig.describeAll();
  assert.equal(JSON.stringify(model).includes(process.env.SMTP_PASS), false);
  assert.equal(find(model, "SMTP_PASS").value, undefined);
  assert.equal(find(model, "SMTP_PASS").hint, "6789");
  assert.equal(find(model, "ORG_NAME").value, "");
  assert.equal(find(model, "ORG_NAME").source, "dashboard");
});
