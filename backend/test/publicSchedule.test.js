"use strict";

process.env.ORG_NAME = "Test Hack";
process.env.ORG_WEBSITE_URL = "https://hackathon.example.com";
process.env.EVENT_TIMEZONE = "America/New_York";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var ScheduleEvent = require("../schemas/scheduleEvent");
var publicSchedule = require("../utils/publicSchedule");

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

function event(title, hour, fields) {
  return Object.assign(
    {
      title: title,
      startsAt: new Date(Date.UTC(2026, 9, 24, hour)),
      endsAt: new Date(Date.UTC(2026, 9, 24, hour + 1)),
    },
    fields || {}
  );
}

test("public schedule feed", async function (t) {
  await db.connect();

  await t.test("with nothing published it is an empty list, and needs no login", async function () {
    await db.clearDatabase();
    publicSchedule.invalidate();
    await ScheduleEvent.create(event("Staff briefing", 12));

    var res = await request(app).get("/api/public/schedule");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      org: { name: "Test Hack", website: "https://hackathon.example.com" },
      timeZone: "America/New_York",
      events: [],
    });
  });

  await t.test("lists only published items, soonest first, with only public fields", async function () {
    await db.clearDatabase();
    publicSchedule.invalidate();
    await ScheduleEvent.create(event("Hacking ends", 18, { published: true, location: "Main hall", description: "Pencils down" }));
    await ScheduleEvent.create(event("Opening ceremony", 14, { published: true, location: "Auditorium" }));
    await ScheduleEvent.create(event("Staff briefing", 12));
    await ScheduleEvent.create(event("Judges' lunch", 16, { published: false }));

    var res = await request(app).get("/api/public/schedule");
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.events.map(function (e) { return e.title; }),
      ["Opening ceremony", "Hacking ends"]
    );
    var first = res.body.events[0];
    assert.deepEqual(Object.keys(first).sort(), ["description", "endsAt", "id", "location", "startsAt", "title"]);
    assert.equal(first.startsAt, "2026-10-24T14:00:00.000Z");
    assert.equal(first.endsAt, "2026-10-24T15:00:00.000Z");
    assert.equal(first.location, "Auditorium");
    assert.equal(first.description, "");
    assert.equal(res.body.events[1].description, "Pencils down");
    assert.ok(!JSON.stringify(res.body).includes("Staff briefing"));
    assert.ok(!JSON.stringify(res.body).includes("Judges"));
  });

  await t.test("browsers and CDNs may cache it; any website may read it, without credentials", async function () {
    var res = await request(app).get("/api/public/schedule").set("Origin", "https://www.some-hackathon-site.example");
    assert.match(res.headers["cache-control"], /public, max-age=60/);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.equal(res.headers["access-control-allow-credentials"], undefined);

    var preflight = await request(app)
      .options("/api/public/schedule")
      .set("Origin", "https://www.some-hackathon-site.example")
      .set("Access-Control-Request-Method", "GET");
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "*");
    assert.match(preflight.headers["access-control-allow-methods"], /GET/);
    assert.ok(!/POST|PUT|PATCH|DELETE/.test(preflight.headers["access-control-allow-methods"]), "read-only");

    // Conditional requests work, so repeat visits cost nothing.
    var again = await request(app).get("/api/public/schedule").set("If-None-Match", res.headers.etag);
    assert.equal(again.status, 304);
  });

  await t.test("the rest of the API does not become public", async function () {
    var res = await request(app).get("/api/public/applications");
    assert.equal(res.status, 404);
    var admin = await request(app).get("/api/admin/schedule").set("Origin", "https://evil.example");
    assert.equal(admin.status, 401);
    assert.equal(admin.headers["access-control-allow-origin"], undefined, "credentialed CORS is unchanged");
  });

  await t.test("the .ics feed holds the same published items", async function () {
    await db.clearDatabase();
    publicSchedule.invalidate();
    await ScheduleEvent.create(event("Opening, with a comma", 14, { published: true, location: "Auditorium", description: "Line one\nLine two" }));
    await ScheduleEvent.create(event("Hacking ends", 18, { published: true }));
    await ScheduleEvent.create(event("Staff briefing", 12));

    var res = await request(app).get("/api/public/schedule.ics");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^text\/calendar; charset=utf-8/);
    assert.match(res.headers["cache-control"], /public, max-age=60/);
    assert.equal(res.headers["access-control-allow-origin"], "*");

    var ics = res.text;
    assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
    assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.ok(ics.includes("X-WR-CALNAME:Test Hack run of show"));
    assert.ok(ics.includes("SUMMARY:Opening\\, with a comma"));
    assert.ok(ics.includes("LOCATION:Auditorium"));
    assert.ok(ics.includes("DESCRIPTION:Line one\\nLine two"));
    assert.ok(ics.includes("DTSTART:20261024T140000Z"));
    assert.ok(ics.includes("URL:https://hackathon.example.com"));
    assert.ok(!ics.includes("Staff briefing"));

    var again = await request(app).get("/api/public/schedule.ics").set("If-None-Match", res.headers.etag);
    assert.equal(again.status, 304);
  });

  await t.test("admins decide what is public; changes show up straight away", async function () {
    await db.clearDatabase();
    publicSchedule.invalidate();
    var admin = await fixtures.createUser({ role: "admin" });

    // New items are private until published.
    var created = await request(app)
      .post("/api/admin/schedule")
      .set(as(admin))
      .send({ title: "Opening ceremony", startsAt: "2026-10-24T14:00:00Z", endsAt: "2026-10-24T15:00:00Z" });
    assert.equal(created.status, 201);
    assert.equal(created.body.event.published, false);
    var id = created.body.event._id;
    assert.deepEqual((await request(app).get("/api/public/schedule")).body.events, []);

    var published = await request(app).patch("/api/admin/schedule/" + id).set(as(admin)).send({ published: true });
    assert.equal(published.status, 200);
    assert.equal(published.body.event.published, true);
    var after = await request(app).get("/api/public/schedule");
    assert.deepEqual(after.body.events.map(function (e) { return e.title; }), ["Opening ceremony"]);
    assert.equal(after.body.events[0].id, id);

    // Editing a published item is visible at once too.
    await request(app).patch("/api/admin/schedule/" + id).set(as(admin)).send({ title: "Opening ceremony (moved)", location: "Hall B" });
    var edited = (await request(app).get("/api/public/schedule")).body.events[0];
    assert.equal(edited.title, "Opening ceremony (moved)");
    assert.equal(edited.location, "Hall B");

    // The admin list shows the flag.
    var list = await request(app).get("/api/admin/schedule").set(as(admin));
    assert.equal(list.body.events[0].published, true);

    // Unpublishing hides it; so does deleting.
    await request(app).patch("/api/admin/schedule/" + id).set(as(admin)).send({ published: false });
    assert.deepEqual((await request(app).get("/api/public/schedule")).body.events, []);
    await request(app).patch("/api/admin/schedule/" + id).set(as(admin)).send({ published: true });
    assert.equal((await request(app).get("/api/public/schedule")).body.events.length, 1);
    await request(app).delete("/api/admin/schedule/" + id).set(as(admin));
    assert.deepEqual((await request(app).get("/api/public/schedule")).body.events, []);

    // Created published in one step.
    var direct = await request(app)
      .post("/api/admin/schedule")
      .set(as(admin))
      .send({ title: "Demos", startsAt: "2026-10-25T14:00:00Z", endsAt: "2026-10-25T15:00:00Z", published: true });
    assert.equal(direct.status, 201);
    assert.equal((await request(app).get("/api/public/schedule")).body.events.length, 1);
  });

  await t.test("published must be true or false, and only admins can change it", async function () {
    await db.clearDatabase();
    publicSchedule.invalidate();
    var admin = await fixtures.createUser({ role: "admin" });
    var mod = await fixtures.createUser({ role: "moderator" });
    var item = await ScheduleEvent.create(event("Opening", 14));

    var bad = await request(app).patch("/api/admin/schedule/" + item._id).set(as(admin)).send({ published: "yes" });
    assert.equal(bad.status, 400);
    var badCreate = await request(app)
      .post("/api/admin/schedule")
      .set(as(admin))
      .send({ title: "X", startsAt: "2026-10-24T14:00:00Z", endsAt: "2026-10-24T15:00:00Z", published: "true" });
    assert.equal(badCreate.status, 400);
    var denied = await request(app).patch("/api/admin/schedule/" + item._id).set(as(mod)).send({ published: true });
    assert.equal(denied.status, 403);
    assert.equal((await ScheduleEvent.findById(item._id)).published, false);
  });

  await t.test("the database is read once per cache window, however many visitors", async function (t2) {
    await db.clearDatabase();
    publicSchedule.invalidate();
    await ScheduleEvent.create(event("Opening", 14, { published: true }));

    var find = t2.mock.method(ScheduleEvent, "find");
    var burst = await Promise.all([1, 2, 3, 4, 5, 6].map(function () { return request(app).get("/api/public/schedule"); }));
    burst.forEach(function (res) {
      assert.equal(res.status, 200);
      assert.equal(res.body.events.length, 1);
    });
    await request(app).get("/api/public/schedule.ics");
    await request(app).get("/api/public/schedule");
    assert.equal(find.mock.callCount(), 1, "one read for all of them, ICS included");

    // Changing the schedule through the admin API forgets the cache.
    publicSchedule.invalidate();
    await request(app).get("/api/public/schedule");
    assert.equal(find.mock.callCount(), 2);
  });

  await t.test("a failed read is an error, is not cached, and recovers", async function (t2) {
    await db.clearDatabase();
    publicSchedule.invalidate();
    await ScheduleEvent.create(event("Opening", 14, { published: true }));
    t2.mock.method(console, "error", function () {});

    var original = ScheduleEvent.find;
    var fail = t2.mock.method(ScheduleEvent, "find", function () {
      throw new Error("db down");
    });
    var down = await request(app).get("/api/public/schedule");
    assert.equal(down.status, 500);
    assert.deepEqual(down.body, { error: "Could not load the schedule." });
    var downIcs = await request(app).get("/api/public/schedule.ics");
    assert.equal(downIcs.status, 500);

    fail.mock.restore();
    assert.equal(ScheduleEvent.find, original);
    var up = await request(app).get("/api/public/schedule");
    assert.equal(up.status, 200);
    assert.equal(up.body.events.length, 1);
  });

  await db.closeDatabase();
});
