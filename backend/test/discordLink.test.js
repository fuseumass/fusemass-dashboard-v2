"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");
var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var User = require("../schemas/user");
var OrgSettings = require("../schemas/orgSettings");
var settingsCache = require("../utils/orgSettingsCache");

function auth(who) { return { Authorization: "Bearer " + who.token }; }

/**
 * Fake Discord: token exchange and /users/@me.
 * @param {object} t - TestContext.
 * @param {object} discordUser - What /users/@me returns.
 * @returns {Array<object>} Recorded calls.
 */
function fakeDiscord(t, discordUser) {
  var calls = [];
  t.mock.method(global, "fetch", function fake(url, init) {
    calls.push({ url: String(url), body: init && init.body ? String(init.body) : "" });
    if (/oauth2\/token$/.test(String(url))) return Promise.resolve(new Response(JSON.stringify({ access_token: "at", refresh_token: "rt" }), { status: 200 }));
    if (/users\/@me$/.test(String(url))) return Promise.resolve(new Response(JSON.stringify(discordUser), { status: 200 }));
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
  return calls;
}

test("Discord account linking", async function (t) {
  await db.connect();
  t.after(db.closeDatabase);
  process.env.DISCORD_APP_CLIENT_ID = "1234567890";
  process.env.DISCORD_APP_CLIENT_SECRET = "secret";
  process.env.CLIENT_ORIGIN = "https://dash.example.com";
  t.after(function () {
    delete process.env.DISCORD_APP_CLIENT_ID;
    delete process.env.DISCORD_APP_CLIENT_SECRET;
  });

  await t.test("status gives a signed authorize URL; callback links; unlink clears", async function (t2) {
    await db.clearDatabase();
    settingsCache.clear();
    var ada = await fixtures.createUser({ name: "Ada" });
    var status = await request(app).get("/api/discord/link").set(auth(ada)).expect(200);
    assert.equal(status.body.configured, true);
    assert.equal(status.body.linked, false);
    var url = new URL(status.body.url);
    assert.equal(url.searchParams.get("client_id"), "1234567890");
    assert.equal(url.searchParams.get("redirect_uri"), "https://dash.example.com/dashboard/discord");
    assert.equal(url.searchParams.get("scope"), "identify");
    var state = url.searchParams.get("state");

    var calls = fakeDiscord(t2, { id: "111111111111111111", username: "ada_l" });
    var linked = await request(app).post("/api/discord/callback").set(auth(ada)).send({ code: "c0de", state: state });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.body, { linked: true, username: "ada_l" });
    assert.match(calls[0].body, /redirect_uri=https%3A%2F%2Fdash\.example\.com%2Fdashboard%2Fdiscord/);
    var saved = await User.findById(ada.user._id).lean();
    assert.equal(saved.discordId, "111111111111111111");
    assert.ok(!JSON.stringify(saved).includes("rt"), "Discord tokens are never stored");
    var after = await request(app).get("/api/discord/link").set(auth(ada)).expect(200);
    assert.equal(after.body.linked, true);
    assert.equal(after.body.username, "ada_l");

    await request(app).delete("/api/discord/link").set(auth(ada)).expect(200);
    assert.equal((await User.findById(ada.user._id).lean()).discordId, undefined);
  });

  await t.test("a state from another account, an expired or forged state is refused", async function (t2) {
    await db.clearDatabase();
    var ada = await fixtures.createUser({ name: "Ada" });
    var eve = await fixtures.createUser({ name: "Eve" });
    var calls = fakeDiscord(t2, { id: "222222222222222222", username: "eve" });
    var eveState = new URL((await request(app).get("/api/discord/link").set(auth(eve))).body.url).searchParams.get("state");
    for (var state of [eveState, "", "123.abc", (Date.now() - 1000) + "." + "a".repeat(64), undefined]) {
      var res = await request(app).post("/api/discord/callback").set(auth(ada)).send({ code: "c0de", state: state });
      assert.equal(res.status, 400, String(state));
    }
    assert.equal(calls.length, 0, "Discord is never called without a valid state");
    assert.equal((await User.findById(ada.user._id).lean()).discordId, undefined);
  });

  await t.test("one Discord account links to one dashboard account", async function (t2) {
    await db.clearDatabase();
    var ada = await fixtures.createUser({ name: "Ada" });
    var bo = await fixtures.createUser({ name: "Bo" });
    fakeDiscord(t2, { id: "333333333333333333", username: "shared" });
    async function link(who) {
      var state = new URL((await request(app).get("/api/discord/link").set(auth(who))).body.url).searchParams.get("state");
      return request(app).post("/api/discord/callback").set(auth(who)).send({ code: "c0de", state: state });
    }
    assert.equal((await link(ada)).status, 200);
    assert.equal((await link(bo)).status, 409);
    assert.equal((await link(ada)).status, 200, "relinking the same account is fine");
  });

  await t.test("not configured, or the Discord module off", async function () {
    await db.clearDatabase();
    settingsCache.clear();
    var ada = await fixtures.createUser({ name: "Ada" });
    delete process.env.DISCORD_APP_CLIENT_ID;
    var status = await request(app).get("/api/discord/link").set(auth(ada)).expect(200);
    assert.equal(status.body.configured, false);
    assert.equal(status.body.url, undefined);
    assert.equal((await request(app).post("/api/discord/callback").set(auth(ada)).send({ code: "x", state: "y" })).status, 503);
    process.env.DISCORD_APP_CLIENT_ID = "1234567890";

    await OrgSettings.updateOne({ key: "default" }, { $set: { "features.discord": false } }, { upsert: true });
    settingsCache.clear();
    var off = await request(app).get("/api/discord/link").set(auth(ada));
    assert.notEqual(off.status, 200);
    await OrgSettings.updateOne({ key: "default" }, { $set: { "features.discord": true } });
    settingsCache.clear();
  });
});
