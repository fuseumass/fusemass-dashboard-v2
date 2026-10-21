"use strict";

// Sets sane defaults for env vars the app needs, without clobbering anything
// already set (e.g. by CI). Must be required before `../../server` so that
// server.js's own `dotenv.config()` call (which never overwrites existing
// process.env values) sees these as already present. Keeps tests self
// contained: no real .env file or secrets required to run them.

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
process.env.MAIL_FROM = process.env.MAIL_FROM || "Test Org <no-reply@test.local>";

module.exports = {};
