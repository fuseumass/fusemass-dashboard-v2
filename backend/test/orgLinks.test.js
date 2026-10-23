"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var orgLinks = require("../utils/orgLinks");

var LINK_ENV = ["ORG_WEBSITE_URL", "ORG_DISCORD_URL", "ORG_DISCORD_MENTORSHIP_URL"];

/**
 * Set env vars for one subtest and restore them afterwards.
 * @param {object} t - The subtest context.
 * @param {object} vars - name -> value (undefined deletes it).
 * @returns {void}
 */
function withEnv(t, vars) {
  var saved = {};
  LINK_ENV.forEach(function each(name) {
    saved[name] = process.env[name];
    if (vars[name] === undefined) delete process.env[name];
    else process.env[name] = vars[name];
  });
  t.after(function restore() {
    LINK_ENV.forEach(function each(name) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    });
  });
}

test("B31: mentorship link (tickets live on Discord)", async function mentorshipLink(t) {
  await db.connect();
  await db.clearDatabase();
  var applicant = await fixtures.createUser({ role: "applicant" });
  var auth = { Authorization: "Bearer " + applicant.token };

  await t.test("needs a login: the links are for participants", async function () {
    var res = await request(app).get("/api/meta/links");
    assert.equal(res.status, 401);
  });

  await t.test("returns the Discord invite and the optional mentorship link", async function (t2) {
    withEnv(t2, {
      ORG_WEBSITE_URL: "https://hackathon.example.com",
      ORG_DISCORD_URL: "https://discord.gg/abc123",
      ORG_DISCORD_MENTORSHIP_URL: "https://discord.com/channels/1/2",
    });
    var res = await request(app).get("/api/meta/links").set(auth);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.links, {
      websiteUrl: "https://hackathon.example.com/",
      discordUrl: "https://discord.gg/abc123",
      mentorshipUrl: "https://discord.com/channels/1/2",
    });
  });

  await t.test("the mentorship link is optional: unset means null", async function (t2) {
    withEnv(t2, { ORG_DISCORD_URL: "https://discord.gg/abc123" });
    var res = await request(app).get("/api/meta/links").set(auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.links.mentorshipUrl, null);
    assert.equal(res.body.links.discordUrl, "https://discord.gg/abc123");
    assert.equal(res.body.links.websiteUrl, null);
  });

  await t.test("read at request time: no restart to add or remove it", async function (t2) {
    withEnv(t2, {});
    assert.equal((await request(app).get("/api/meta/links").set(auth)).body.links.mentorshipUrl, null);
    process.env.ORG_DISCORD_MENTORSHIP_URL = "https://discord.gg/mentors";
    assert.equal((await request(app).get("/api/meta/links").set(auth)).body.links.mentorshipUrl, "https://discord.gg/mentors");
    delete process.env.ORG_DISCORD_MENTORSHIP_URL;
    assert.equal((await request(app).get("/api/meta/links").set(auth)).body.links.mentorshipUrl, null);
  });

  await t.test("anything that isn't a plain http(s) URL is dropped", function (t2) {
    withEnv(t2, {});
    ["javascript:alert(1)", "data:text/html,<script>1</script>", "discord.gg/abc", "not a url", "https://u:p@discord.gg/x", ""].forEach(
      function (bad) {
        process.env.ORG_DISCORD_MENTORSHIP_URL = bad;
        process.env.ORG_DISCORD_URL = bad;
        var links = orgLinks.getLinks();
        assert.equal(links.mentorshipUrl, null, JSON.stringify(bad));
        assert.equal(links.discordUrl, null, JSON.stringify(bad));
      }
    );
  });

  await db.closeDatabase();
});
