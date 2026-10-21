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
var clientOrigin = require("../utils/clientOrigin");

var ORIGINS = "https://dash.example.com, https://www.dash.example.com/";

/**
 * Set CLIENT_ORIGIN for one subtest.
 * @param {object} t - Subtest context.
 * @param {string} value - The list.
 * @returns {void}
 */
function useOrigins(t, value) {
  var saved = process.env.CLIENT_ORIGIN;
  process.env.CLIENT_ORIGIN = value;
  t.after(function restore() {
    process.env.CLIENT_ORIGIN = saved;
  });
}

/**
 * Preflight /api/auth/login from an origin.
 * @param {string} origin - Origin header.
 * @returns {Promise<object>} supertest response.
 */
function preflight(origin) {
  return request(app)
    .options("/api/auth/login")
    .set("Origin", origin)
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "content-type");
}

test("CLIENT_ORIGIN with several frontend addresses", async function (t) {
  await t.test("parses the list: trimmed, no trailing slash, primary first", function (t2) {
    useOrigins(t2, ORIGINS);
    assert.deepEqual(clientOrigin.clientOrigins(), ["https://dash.example.com", "https://www.dash.example.com"]);
    assert.equal(clientOrigin.primaryClientOrigin(), "https://dash.example.com");
  });

  await t.test("a single address still works; empty falls back to localhost", function (t2) {
    useOrigins(t2, "https://only.example.com");
    assert.deepEqual(clientOrigin.clientOrigins(), ["https://only.example.com"]);
    process.env.CLIENT_ORIGIN = " , ";
    assert.equal(clientOrigin.primaryClientOrigin(), "http://localhost:3000");
  });

  await t.test("CORS allows every listed address, echoing the one that asked", async function (t2) {
    useOrigins(t2, ORIGINS);
    var main = await preflight("https://dash.example.com");
    assert.equal(main.headers["access-control-allow-origin"], "https://dash.example.com");
    var www = await preflight("https://www.dash.example.com");
    assert.equal(www.headers["access-control-allow-origin"], "https://www.dash.example.com");
    assert.equal(www.headers["access-control-allow-credentials"], "true");
  });

  await t.test("CORS gives an unlisted address nothing to read", async function (t2) {
    useOrigins(t2, ORIGINS);
    var evil = await preflight("https://evil.example.com");
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
    var lookalike = await preflight("https://dash.example.com.evil.example.com");
    assert.equal(lookalike.headers["access-control-allow-origin"], undefined);
  });

  await t.test("requests without an Origin (curl, server-to-server) are unaffected", async function (t2) {
    useOrigins(t2, ORIGINS);
    var res = await request(app).get("/api/health");
    assert.equal(res.status, 200);
  });

  await db.connect();

  await t.test("emailed links use the first address", async function (t2) {
    useOrigins(t2, ORIGINS);
    await db.clearDatabase();
    var mail = mailMock.mockTransport(t2);
    var user = await fixtures.createUser({ email: "ada@example.com" });
    assert.ok(user);

    var res = await request(app).post("/api/auth/forgot-password").send({ email: "ada@example.com" });
    assert.equal(res.status, 200);
    await waitFor(function () {
      return mail.calls.length >= 1;
    });
    assert.match(mail.calls[0].text, /https:\/\/dash\.example\.com\/reset-password\?token=/);
    assert.equal(mail.calls[0].text.indexOf("www.dash.example.com"), -1);
  });

  await db.closeDatabase();
});
