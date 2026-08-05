"use strict";

// Sets sane defaults for env vars the app needs, without clobbering anything
// already set (e.g. by CI). Must be required before `../../server` so that
// server.js's own `dotenv.config()` call (which never overwrites existing
// process.env values) sees these as already present. Keeps tests self
// contained: no real .env file or secrets required to run them.

process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/hackdash_test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-do-not-use-in-production";
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
process.env.CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:3000";
process.env.ORG_NAME = process.env.ORG_NAME || "Test Org";
process.env.SETUP_ADMIN = process.env.SETUP_ADMIN || "false";
process.env.GOOGLE_AUTH_ENABLED = process.env.GOOGLE_AUTH_ENABLED || "false";

module.exports = {};
