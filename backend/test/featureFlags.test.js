"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var express = require("express");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var features = require("../utils/features");
var requireFeature = require("../utils/requireFeature");
var orgSettingsCache = require("../utils/orgSettingsCache");
var OrgSettings = require("../schemas/orgSettings");
var MealService = require("../schemas/mealService");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

function setFlags(admin, flags) {
  return request(app).patch("/api/admin/settings").set(as(admin)).send({ features: flags });
}

test("B25: feature flags per module", async function featureFlags(t) {
  // ---- Pure helpers ---------------------------------------------------------

  await t.test("a flag is off only when it is explicitly false", function () {
    assert.equal(features.isEnabled(null, "meals"), true, "no settings at all");
    assert.equal(features.isEnabled({}, "meals"), true, "no features object");
    assert.equal(features.isEnabled({ features: null }, "meals"), true);
    assert.equal(features.isEnabled({ features: {} }, "meals"), true, "flag missing");
    assert.equal(features.isEnabled({ features: { meals: undefined } }, "meals"), true);
    assert.equal(features.isEnabled({ features: { meals: null } }, "meals"), true);
    assert.equal(features.isEnabled({ features: { meals: 0 } }, "meals"), true, "only false turns it off");
    assert.equal(features.isEnabled({ features: { meals: false } }, "meals"), false);
    assert.deepEqual(features.resolve({ features: { raffle: false } }), {
      meals: true,
      hardware: true,
      workshops: true,
      judging: true,
      raffle: false,
    });
  });

  await t.test("requireFeature refuses an unknown feature when the router is built", function () {
    assert.throws(function () {
      requireFeature("mentorship");
    }, /unknown feature/);
  });

  await db.connect();

  // ---- Defaults and the public flags ----------------------------------------

  await t.test("every flag defaults to on, with no settings document at all", async function () {
    await db.clearDatabase();
    var res = await request(app).get("/api/meta/branding");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.features, {
      meals: true,
      hardware: true,
      workshops: true,
      judging: true,
      raffle: true,
    });
  });

  await t.test("a settings document saved before flags existed means all on", async function () {
    await db.clearDatabase();
    // Written straight to the collection: no Mongoose defaults, no `features`.
    await OrgSettings.collection.insertOne({ key: "default", publicApplications: false });
    var admin = await fixtures.createUser({ role: "admin" });
    var mod = await fixtures.createUser({ role: "moderator" });

    var meta = await request(app).get("/api/meta/branding");
    assert.equal(meta.body.features.meals, true);

    var meals = await request(app).get("/api/staff/meals").set(as(mod));
    assert.equal(meals.status, 200, "the gate must not crash or block on a missing flag");

    var settings = await request(app).get("/api/admin/settings").set(as(admin));
    assert.equal(settings.body.settings.features.meals, true, "the admin view shows defaults too");
  });

  // ---- Editing flags --------------------------------------------------------

  await t.test("PATCH /api/admin/settings changes only the flags sent", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await setFlags(admin, { meals: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.features.meals, false);
    assert.equal(res.body.settings.features.hardware, true);

    res = await setFlags(admin, { raffle: false });
    assert.equal(res.body.settings.features.meals, false, "an earlier flag is kept");
    assert.equal(res.body.settings.features.raffle, false);

    res = await setFlags(admin, { meals: true });
    assert.equal(res.body.settings.features.meals, true);
    assert.equal(res.body.settings.features.raffle, false);

    var pub = await request(app).get("/api/meta/branding");
    assert.equal(pub.body.features.raffle, false);
    assert.equal(pub.body.features.meals, true);
  });

  await t.test("rejects flags that aren't real booleans, and unknown flags", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });

    // "false" is a truthy string: coercing it would turn a module ON.
    var res = await setFlags(admin, { meals: "false" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /features\.meals must be true or false/);

    for (var bad of [0, 1, null, "off", {}, []]) {
      res = await setFlags(admin, { hardware: bad });
      assert.equal(res.status, 400, "rejects " + JSON.stringify(bad));
    }

    res = await setFlags(admin, { mentorship: false });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Unknown feature "mentorship"/);

    res = await request(app).patch("/api/admin/settings").set(as(admin)).send({ features: "meals" });
    assert.equal(res.status, 400);
    res = await request(app).patch("/api/admin/settings").set(as(admin)).send({ features: [true] });
    assert.equal(res.status, 400);

    // A request with one bad flag saves nothing, not even its good flags.
    res = await setFlags(admin, { hardware: false, meals: "nope" });
    assert.equal(res.status, 400);
    var settings = await request(app).get("/api/admin/settings").set(as(admin));
    assert.equal(settings.body.settings.features.hardware, true);
  });

  await t.test("only admins can change flags", async function () {
    await db.clearDatabase();
    var mod = await fixtures.createUser({ role: "moderator" });
    var applicant = await fixtures.createUser({ role: "applicant" });

    assert.equal((await setFlags(mod, { meals: false })).status, 403);
    assert.equal((await setFlags(applicant, { meals: false })).status, 403);
    var anon = await request(app).patch("/api/admin/settings").send({ features: { meals: false } });
    assert.equal(anon.status, 401);
    assert.equal((await request(app).get("/api/meta/branding")).body.features.meals, true);
  });

  await t.test("the admin settings view lists the switchable modules", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var res = await request(app).get("/api/admin/settings").set(as(admin));
    assert.deepEqual(
      res.body.featureOptions.map(function (o) {
        return o.key;
      }),
      ["meals", "hardware", "workshops", "judging", "raffle"]
    );
    assert.equal(res.body.featureOptions[0].label, "Meals");
  });

  // ---- The gate on a real module (meals) ------------------------------------

  await t.test("switching meals off makes every meals route 404 for everyone, admins included", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var mod = await fixtures.createUser({ role: "moderator" });
    var applicant = await fixtures.createUser({ role: "applicant" });
    var lunch = await MealService.create({
      name: "Lunch",
      startsAt: new Date(Date.now() - 3600 * 1000),
      endsAt: new Date(Date.now() + 3600 * 1000),
      active: true,
    });

    // On: reachable as before.
    assert.equal((await request(app).get("/api/admin/meals").set(as(admin))).status, 200);
    assert.equal((await request(app).get("/api/staff/meals").set(as(mod))).status, 200);

    assert.equal((await setFlags(admin, { meals: false })).status, 200);

    var routes = [
      ["get", "/api/admin/meals"],
      ["post", "/api/admin/meals"],
      ["patch", "/api/admin/meals/" + lunch._id],
      ["delete", "/api/admin/meals/" + lunch._id],
      ["get", "/api/staff/meals"],
      ["post", "/api/staff/meals/" + lunch._id + "/checkin"],
    ];
    for (var who of [admin, mod, applicant, null]) {
      for (var route of routes) {
        var req = request(app)[route[0]](route[1]);
        if (who) req = req.set(as(who));
        var res = await req.send({});
        assert.equal(
          res.status,
          404,
          route[0].toUpperCase() + " " + route[1] + " as " + (who ? who.user.role : "anonymous")
        );
        assert.equal(res.body.error, "This feature is not enabled.");
      }
    }

    // Nothing was half-done behind the 404.
    assert.equal(await MealService.countDocuments({}), 1);

    // Back on: everything works again.
    assert.equal((await setFlags(admin, { meals: true })).status, 200);
    assert.equal((await request(app).get("/api/admin/meals").set(as(admin))).status, 200);
    assert.equal((await request(app).get("/api/staff/meals").set(as(mod))).status, 200);
  });

  await t.test("other modules are unaffected by a flag that isn't theirs", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var mod = await fixtures.createUser({ role: "moderator" });
    var applicant = await fixtures.createUser({ role: "applicant" });

    // Every flag off: check-in, teams, settings and the review list still work.
    var res = await setFlags(admin, { meals: false, hardware: false, workshops: false, judging: false, raffle: false });
    assert.equal(res.status, 200);

    assert.equal((await request(app).get("/api/staff/checkin/stats").set(as(mod))).status, 200);
    assert.equal((await request(app).get("/api/teams/me").set(as(applicant))).status, 200);
    assert.equal((await request(app).get("/api/admin/teams").set(as(mod))).status, 200);
    assert.equal((await request(app).get("/api/admin/settings").set(as(admin))).status, 200);
    assert.equal((await request(app).get("/api/admin/applications").set(as(mod))).status, 200);
    // ...and the admin can always switch things back on.
    assert.equal((await setFlags(admin, { meals: true })).status, 200);
  });

  await t.test("an unauthenticated visitor sees 404, not 401, while the module is off", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    assert.equal((await request(app).get("/api/staff/meals")).status, 401, "on: auth is required");
    await setFlags(admin, { meals: false });
    assert.equal((await request(app).get("/api/staff/meals")).status, 404, "off: indistinguishable for everyone");
  });

  // ---- requireFeature on its own router (how future modules mount it) -------

  await t.test("requireFeature gates a router and mounts before the auth guards", async function () {
    await db.clearDatabase();
    var mini = express();
    var hits = 0;
    mini.use("/hardware", requireFeature("hardware"));
    mini.get("/hardware/items", function items(_req, res) {
      hits += 1;
      res.status(200).json({ ok: true });
    });
    mini.use(function onError(err, _req, res, _next) {
      res.status(500).json({ error: err.message });
    });
    var admin = await fixtures.createUser({ role: "admin" });

    assert.equal((await request(mini).get("/hardware/items")).status, 200);
    await setFlags(admin, { hardware: false });
    assert.equal((await request(mini).get("/hardware/items")).status, 404);
    assert.equal(hits, 1, "the handler never ran while the feature was off");
    await setFlags(admin, { hardware: true });
    assert.equal((await request(mini).get("/hardware/items")).status, 200);
  });

  // ---- The settings cache: cheap on Cosmos DB, never stale after a write -----

  await t.test("the settings snapshot is cached, shared between concurrent requests, and cleared on write", async function (t2) {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var previousTtl = process.env.SETTINGS_CACHE_TTL_MS;
    process.env.SETTINGS_CACHE_TTL_MS = "60000";
    t2.after(function restore() {
      process.env.SETTINGS_CACHE_TTL_MS = previousTtl;
      orgSettingsCache.clear();
    });
    orgSettingsCache.clear();

    var original = OrgSettings.findOne;
    var queries = 0;
    t2.mock.method(OrgSettings, "findOne", function counted() {
      queries += 1;
      return original.apply(OrgSettings, arguments);
    });

    // Ten concurrent requests share one query...
    var results = await Promise.all(
      Array.from({ length: 10 }, function () {
        return request(app).get("/api/meta/branding");
      })
    );
    results.forEach(function (r) {
      assert.equal(r.status, 200);
    });
    assert.equal(queries, 1, "one database read for ten concurrent requests");

    // ...and later requests inside the TTL don't query at all.
    await request(app).get("/api/meta/branding");
    await request(app).get("/api/meta/branding");
    assert.equal(queries, 1);

    // A change made behind the API's back is not seen until the TTL ends...
    await OrgSettings.collection.updateOne({ key: "default" }, { $set: { "features.raffle": false } }, { upsert: true });
    assert.equal((await request(app).get("/api/meta/branding")).body.features.raffle, true);

    // ...but a change made through the API is visible on the very next request.
    var res = await setFlags(admin, { workshops: false });
    assert.equal(res.status, 200);
    var after = await request(app).get("/api/meta/branding");
    assert.equal(after.body.features.workshops, false);
    assert.equal(after.body.features.raffle, false, "the direct edit is picked up by the refresh");
  });

  await t.test("a failed refresh serves the last good settings; with none, the gate errors instead of guessing", async function (t2) {
    await db.clearDatabase();
    var previousTtl = process.env.SETTINGS_CACHE_TTL_MS;
    process.env.SETTINGS_CACHE_TTL_MS = "0";
    t2.after(function restore() {
      process.env.SETTINGS_CACHE_TTL_MS = previousTtl;
      orgSettingsCache.clear();
    });
    orgSettingsCache.clear();
    await OrgSettings.create({ key: "default", features: { hardware: false } });
    // The controller logs the failure; keep that out of the test output.
    t2.mock.method(console, "error", function quiet() {});

    var good = await orgSettingsCache.get();
    assert.equal(good.features.hardware, false);

    var original = OrgSettings.findOne;
    var broken = true;
    t2.mock.method(OrgSettings, "findOne", function maybeBroken() {
      if (broken) {
        return {
          lean: function failing() {
            return Promise.reject(new Error("database down"));
          },
        };
      }
      return original.apply(OrgSettings, arguments);
    });

    var stale = await orgSettingsCache.get();
    assert.equal(stale.features.hardware, false, "last good copy while the database is down");

    // The public endpoint keeps answering.
    var res = await request(app).get("/api/meta/branding");
    assert.equal(res.status, 200);
    assert.equal(res.body.features.hardware, false);

    // With no copy at all, requireFeature reports the failure.
    orgSettingsCache.clear();
    var mini = express();
    mini.use(requireFeature("hardware"));
    mini.get("/x", function ok(_req, r) {
      r.status(200).json({ ok: true });
    });
    mini.use(function onError(err, _req, r, _next) {
      r.status(500).json({ error: err.message });
    });
    var failing = await request(mini).get("/x");
    assert.equal(failing.status, 500, "fails closed rather than serving a module whose flag is unknown");

    // The public branding endpoint degrades to defaults, cached only briefly.
    var degraded = await request(app).get("/api/meta/branding");
    assert.equal(degraded.status, 200);
    assert.equal(degraded.headers["cache-control"], "public, max-age=5");
    broken = false;
  });

  await db.closeDatabase();
});
