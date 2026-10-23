"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var dotenv = require("dotenv");
var jwt = require("jsonwebtoken");
var systemConfig = require("../utils/systemConfig");
var controller = require("../controllers/systemConfigController");
var parseToken = require("../utils/parseToken");
var isAdmin = require("../utils/isAdmin");

var URL_PATH = "/api/admin/system-config";

/**
 * @param {object} model - Page metadata.
 * @param {string} key - Setting key.
 * @returns {object} Setting metadata.
 */
function find(model, key) {
  return model.settings.find(function match(item) { return item.key === key; });
}

test("technical settings file API (no database)", async function suite(t) {
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), "system-config-test-"));
  var filename = path.join(directory, ".env");
  var saved = {};
  ["ENV_FILE_PATH", "JWT_SECRET", "ALLOW_SELF_RESTART"].concat(systemConfig.REGISTRY.map(function key(item) { return item.key; })).forEach(function remember(key) {
    saved[key] = process.env[key];
  });
  process.env.ENV_FILE_PATH = filename;
  process.env.JWT_SECRET = "test-only-system-config-signing-secret";
  delete process.env.ALLOW_SELF_RESTART;
  t.after(function cleanup() {
    Object.keys(saved).forEach(function restore(key) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  t.mock.method(require("../schemas/user"), "findById", function lookup(id) {
    return { select: function select() { return { lean: function lean() { return Promise.resolve({ role: id }); } }; } };
  });

  var audit = [];
  t.mock.method(console, "log", function capture(message) { audit.push(message); });

  // Exercise production controllers and guards without opening a socket.
  /**
   * @param {string} method - HTTP method.
   * @param {object} [values] - Patch values.
   * @param {string|null} [role] - Caller role.
   * @returns {object} Supertest request.
   */
  function call(method, values, role) {
    return new Promise(function dispatch(resolve, reject) {
      var token = role === null ? null : jwt.sign({ id: role || "admin", role: role || "admin" }, process.env.JWT_SECRET);
      var req = {
        body: { values: values }, headers: token ? { authorization: "Bearer " + token } : {},
        get: function get(name) { return req.headers[name.toLowerCase()]; },
      };
      var result = { status: 200, headers: {} };
      var res = {
        set: function set(key, value) { result.headers[key.toLowerCase()] = value; return res; },
        status: function status(code) { result.status = code; return res; },
        json: function json(body) { result.body = body; result.text = JSON.stringify(body); resolve(result); return res; },
      };
      parseToken(req, res, function parsed() {
        isAdmin(req, res, function authorized(err) {
          if (err) return reject(err);
          Promise.resolve(method === "get" ? controller.getSystemConfig(req, res) : method === "post" ? controller.restartServer(req, res) : controller.updateSystemConfig(req, res)).catch(reject);
        });
      });
    });
  }

  await t.test("admin-only read and write", async function () {
    for (var role of [null, "applicant", "moderator"]) {
      assert.equal((await call("get", null, role)).status, role ? 403 : 401);
      assert.equal((await call("patch", { ORG_NAME: "denied" }, role)).status, role ? 403 : 401);
      assert.equal((await call("post", null, role)).status, role ? 403 : 401);
    }
    assert.equal((await call("post")).status, 409);
    assert.equal(fs.existsSync(filename), false);
    assert.equal(require("mongoose").models.SystemSetting, undefined);
  });

  var initial = "# keep this comment\r\nORG_NAME=Before # old\r\n\r\nUNRELATED=unchanged\r\nSMTP_HOST=old.example\r\nSMTP_HOST=duplicate.example\r\n# last\r\n";
  fs.writeFileSync(filename, initial, { mode: 0o640 });

  await t.test("invalid batch leaves bytes, environment and backup untouched", async function () {
    var before = process.env.ORG_NAME;
    var res = await call("patch", { ORG_NAME: "Should not land", SMTP_PORT: "99999", SMTP_PASS: "bad\nvalue" });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.SMTP_PORT);
    assert.ok(res.body.errors.SMTP_PASS);
    assert.equal(fs.readFileSync(filename, "utf8"), initial);
    assert.equal(process.env.ORG_NAME, before);
    assert.equal(fs.existsSync(filename + ".previous"), false);
    for (var key of ["MONGODB_URI", "PORT", "NODE_ENV", "JWT_SECRET", "JWT_EXPIRES_IN", "SETUP_ADMIN", "ALLOW_SELF_RESTART", "CLIENT_ORIGIN", "TRUST_PROXY", "UNKNOWN_KEY", "__proto__", "constructor"]) {
      var values = JSON.parse('{"ORG_NAME":"Valid","' + key + '":null}');
      var denied = await call("patch", values);
      assert.equal(denied.status, 400, key);
      assert.ok(denied.body.errors[key], key);
    }
    assert.equal(fs.readFileSync(filename, "utf8"), initial);
    assert.equal((await call("patch", {})).status, 400);
  });

  await t.test("replace, append, remove duplicates, backup and mode", async function () {
    var res = await call("patch", { ORG_NAME: "After name", SMTP_PASS: "a secret", SMTP_HOST: null });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.changed, ["ORG_NAME", "SMTP_PASS", "SMTP_HOST"]);
    assert.deepEqual(res.body.restartRequired, []);
    assert.equal(fs.readFileSync(filename, "utf8"), '# keep this comment\r\nORG_NAME="After name"\r\n\r\nUNRELATED=unchanged\r\n# last\r\nSMTP_PASS="a secret"\r\n');
    assert.equal(fs.readFileSync(filename + ".previous", "utf8"), initial);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o640);
    assert.equal(fs.statSync(filename + ".previous").mode & 0o777, 0o640);
    assert.equal(process.env.ORG_NAME, "After name");
    assert.equal(process.env.SMTP_PASS, "a secret");
    assert.equal(process.env.SMTP_HOST, undefined);
    assert.equal(find(res.body, "ORG_NAME").source, "env");
    assert.equal(find(res.body, "SMTP_HOST").source, "unset");
    var beforeRemove = fs.readFileSync(filename, "utf8");
    var removed = await call("patch", { ORG_NAME: null });
    assert.equal(removed.status, 200);
    assert.equal(process.env.ORG_NAME, undefined);
    assert.equal(find(removed.body, "ORG_NAME").source, "default");
    assert.equal(find(removed.body, "ORG_NAME").isSet, false);
    assert.equal(fs.readFileSync(filename + ".previous", "utf8"), beforeRemove);
  });

  await t.test("dotenv round-trips spaces, quotes, hashes, equals and backslashes", async function () {
    for (var value of ['  secret  ', 'say "hello" # = yes', "it's a secret", 'C:\\new\\route']) {
      assert.equal((await call("patch", { SMTP_PASS: value })).status, 200);
      assert.equal(dotenv.parse(fs.readFileSync(filename)).SMTP_PASS, value);
      assert.equal(process.env.SMTP_PASS, value);
    }
  });

  await t.test("unrepresentable dotenv quoting rejects the entire batch", async function () {
    var before = fs.readFileSync(filename);
    var res = await call("patch", { ORG_NAME: "Must not land", SMTP_PASS: '\"both\' quotes\" and `ticks` # =' });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.SMTP_PASS);
    assert.deepEqual(fs.readFileSync(filename), before);
  });

  await t.test("unchanged values do not replace the file or backup", async function () {
    var before = fs.readFileSync(filename);
    var backup = fs.readFileSync(filename + ".previous");
    var res = await call("patch", { SMTP_PASS: process.env.SMTP_PASS });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.changed, []);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.deepEqual(fs.readFileSync(filename + ".previous"), backup);
  });

  await t.test("concurrent PATCHes both land and restart metadata is preserved", async function () {
    var responses = await Promise.all([
      call("patch", { ORG_NAME: "Concurrent name" }),
      call("patch", { GOOGLE_CLIENT_SECRET: "concurrent-secret" }),
    ]);
    responses.forEach(function ok(res) { assert.equal(res.status, 200); });
    assert.deepEqual(responses[1].body.restartRequired, ["GOOGLE_CLIENT_SECRET"]);
    var parsed = dotenv.parse(fs.readFileSync(filename));
    assert.equal(parsed.ORG_NAME, "Concurrent name");
    assert.equal(parsed.GOOGLE_CLIENT_SECRET, "concurrent-secret");
    assert.equal(process.env.GOOGLE_CLIENT_SECRET, "concurrent-secret");
  });

  await t.test("GET returns metadata only for every setting", async function () {
    var res = await call("get");
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    for (var item of res.body.settings) {
      assert.equal(item.value, undefined);
      assert.equal(item.defaultValue, undefined);
      assert.equal(item.hint, undefined);
      assert.ok(["env", "default", "unset"].includes(item.source));
    }
    for (var value of [process.env.SMTP_PASS, process.env.JWT_SECRET, "Concurrent name", "concurrent-secret"]) {
      assert.equal(res.text.includes(value), false);
    }
  });

  await t.test("new files use 0600 and appends handle missing final newline", async function () {
    fs.unlinkSync(filename);
    assert.equal((await call("patch", { SMTP_PORT: "2525" })).status, 200);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    fs.writeFileSync(filename, "# no final newline");
    assert.equal((await call("patch", { ORG_NAME: "Appended" })).status, 200);
    assert.equal(fs.readFileSync(filename, "utf8"), "# no final newline\nORG_NAME=Appended\n");
  });

  await t.test("failed rename leaves file and environment intact; next save succeeds", async function () {
    var original = fs.readFileSync(filename, "utf8");
    var previousEnv = process.env.ORG_NAME;
    var mock = t.mock.method(fs, "renameSync", function fail() { throw new Error("private-file-value"); });
    var res = await call("patch", { ORG_NAME: "Failed" });
    assert.equal(res.status, 500);
    assert.equal(res.text.includes("private-file-value"), false);
    assert.equal(fs.readFileSync(filename, "utf8"), original);
    assert.equal(process.env.ORG_NAME, previousEnv);
    mock.mock.restore();
    assert.equal((await call("patch", { ORG_NAME: "Recovered" })).status, 200);
    assert.equal(dotenv.parse(fs.readFileSync(filename)).ORG_NAME, "Recovered");
  });
  await t.test("audit logs contain only admin id and changed key names", function () {
    assert.ok(audit.length > 0);
    audit.forEach(function keysOnly(message) {
      assert.match(message, /^Technical settings changed by admin: [A-Z_]+(?:, [A-Z_]+)*$/);
    });
  });
});

test("restart uses injected exit exactly once", async function () {
  var exits = [];
  systemConfig.setRestartHooks({ exit: function fake(code) { exits.push(code); }, delayMs: 1, forceAfterMs: 10 });
  systemConfig.scheduleRestart();
  await new Promise(function wait(resolve) { setTimeout(resolve, 30); });
  assert.deepEqual(exits, [0]);
});
