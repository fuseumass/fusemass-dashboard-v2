"use strict";

// Sets sane defaults for env vars the app needs, without clobbering anything
// already set (e.g. by CI). Must be required before `../../server` so that
// server.js's own `dotenv.config()` call (which never overwrites existing
// process.env values) sees these as already present. Keeps tests self
// contained: no real .env file or secrets required to run them.

// Every test process gets its own dotenv path, including permission-matrix
// requests. Never load or modify a developer's real .env, even if a test save
// unexpectedly passes its guard.
var fs = require("node:fs");
var path = require("node:path");
var testEnvDirectory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "dashboard-test-env-"));
process.env.ENV_FILE_PATH = path.join(testEnvDirectory, ".env");
fs.writeFileSync(process.env.ENV_FILE_PATH, "", { mode: 0o600 });
process.on("exit", function cleanupTestEnv() {
  fs.rmSync(testEnvDirectory, { recursive: true, force: true });
});

// Node's test runner runs each test file as its own process, often
// concurrently. They all share one real local MongoDB server, so each file
// needs its own database name — otherwise one file's dropDatabase()/seeding
// races another file's. Only applied when MONGODB_URI isn't already set
// (e.g. by CI), so a fixed URI there is left alone.
if (!process.env.MONGODB_URI) {
  var randomSuffix = require("crypto").randomBytes(6).toString("hex");
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/hackdash_test_" + randomSuffix;
}
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-do-not-use-in-production";
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
process.env.CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";
process.env.ORG_NAME = process.env.ORG_NAME || "Test Org";
process.env.SETUP_ADMIN = process.env.SETUP_ADMIN || "false";
process.env.GOOGLE_AUTH_ENABLED = process.env.GOOGLE_AUTH_ENABLED || "false";
// The in-process settings cache (utils/orgSettingsCache) would otherwise hand
// a test the settings from before it edited them directly in the database.
if (process.env.SETTINGS_CACHE_TTL_MS === undefined) {
  process.env.SETTINGS_CACHE_TTL_MS = "0";
}

// Fake SMTP config so mailer.isMailConfigured() is true and template emails
// actually attempt to render/send (tests mock nodemailer's transport itself,
// see helpers/mailMock.js, so nothing real ever goes over the network).
process.env.SMTP_HOST = process.env.SMTP_HOST || "smtp.test.local";
process.env.SMTP_USER = process.env.SMTP_USER || "test@test.local";
process.env.SMTP_PASS = process.env.SMTP_PASS || "test-password";
// No pause between sends in tests (production paces them, see utils/mailer).
if (process.env.EMAIL_MIN_INTERVAL_MS === undefined) {
  process.env.EMAIL_MIN_INTERVAL_MS = "0";
}
process.env.MAIL_FROM = process.env.MAIL_FROM || "Test Org <no-reply@test.local>";

// supertest starts a server per request with `listen(0)`, which binds the
// wildcard address, then connects to 127.0.0.1:<port>. On a machine that runs
// other local servers, one of them can already hold that very port on
// 127.0.0.1 (a specific address wins over the wildcard, and the OS lets both
// bind), so the request is answered by a stranger: a stray 404 / 400 / 401 on
// a random test. Binding to 127.0.0.1 makes the OS hand out a port that is
// really free there. supertest reads server.address() right after listen(),
// so the bind has to be synchronous; listen(0, "127.0.0.1") is not (it does a
// DNS lookup first), hence the lower-level _listen2 that it ends up calling.
var http = require("node:http");
var originalListen = http.Server.prototype.listen;
http.Server.prototype.listen = function listenOnLoopback() {
  var args = Array.prototype.slice.call(arguments);
  if (args.length <= 2 && args[0] === 0 && typeof this._listen2 === "function") {
    if (typeof args[1] === "function") {
      this.once("listening", args[1]);
    }
    this._listen2("127.0.0.1", 0, 4, 511);
    return this;
  }
  return originalListen.apply(this, args);
};

module.exports = {};
