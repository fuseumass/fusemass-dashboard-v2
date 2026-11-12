"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var flaky = require("./helpers/flakyMail");
var app = require("../server");
var communications = require("../utils/communications");
var discordAnnouncements = require("../utils/discordAnnouncements");
var outbox = require("../utils/outbox");
var Announcement = require("../schemas/announcement");
var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var AutomationLog = require("../schemas/automationLog");
var CommunicationSettings = require("../schemas/communicationSettings");
var EmailLog = require("../schemas/emailLog");
var EmailTemplate = require("../schemas/emailTemplate");
var User = require("../schemas/user");
var Workshop = require("../schemas/workshop");
var Signup = require("../schemas/workshopSignup");

var ANNOUNCE_URL = "https://discord.test/api/webhooks/1/announce";
var WORKSHOPS_URL = "https://discord.test/api/webhooks/2/workshops";
var MINUTE = 60 * 1000;

/**
 * @param {object} who - {token} from fixtures.createUser.
 * @returns {object} Header object for supertest .set().
 */
function as(who) {
  return { Authorization: "Bearer " + who.token };
}

/**
 * Replace fetch with a fake Discord that records every post. `respond` can
 * queue status codes (e.g. 429) for the next posts.
 * @param {object} t - TestContext.
 * @returns {{posts: Array<object>, queue: Array<object>}}
 */
function fakeDiscord(t) {
  var state = { posts: [], queue: [] };
  t.mock.method(global, "fetch", function fakeFetch(url, init) {
    var next = state.queue.shift();
    state.posts.push({ url: String(url), body: JSON.parse(init.body) });
    if (next && next.status === 429) {
      return Promise.resolve(
        new Response(JSON.stringify({ retry_after: next.retryAfter || 0.01, global: false }), { status: 429 })
      );
    }
    if (next && next.status) {
      return Promise.resolve(new Response("{}", { status: next.status }));
    }
    return Promise.resolve(new Response(JSON.stringify({ id: "msg-" + state.posts.length }), { status: 200 }));
  });
  return state;
}

/**
 * Fresh database, templates, webhooks configured.
 * @returns {Promise<void>}
 */
async function reset() {
  outbox.resetBreaker();
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
  process.env.DISCORD_ANNOUNCEMENTS_WEBHOOK_URL = ANNOUNCE_URL;
  process.env.DISCORD_WORKSHOPS_WEBHOOK_URL = WORKSHOPS_URL;
}

/**
 * Wait until the outbox has no queued rows (the bulk send drains in the background).
 * @returns {Promise<void>}
 */
async function settle() {
  await outbox.processDue({ force: true });
}

/**
 * A published workshop starting `minutes` from now, with sign-ups.
 * @param {number} minutes - Start offset.
 * @param {Array<object>} people - Users to sign up.
 * @param {object} [extra] - Field overrides.
 * @returns {Promise<object>}
 */
async function workshopIn(minutes, people, extra) {
  var startsAt = new Date(Date.now() + minutes * MINUTE);
  var workshop = await Workshop.create(
    Object.assign(
      {
        title: "Hackathon Playbook",
        host: "Sam",
        location: "Room 101",
        startsAt: startsAt,
        endsAt: new Date(startsAt.getTime() + 60 * MINUTE),
        published: true,
        capacity: 20,
        signupCount: people.length,
      },
      extra || {}
    )
  );
  for (var person of people) {
    await Signup.create({ user: person.user._id, workshop: workshop._id });
  }
  return workshop;
}

test("communications: announcements, Discord and workshop automations", async function communicationsTest(t) {
  await db.connect();

  await t.test("Discord payloads respect the limits and never ping by accident", async function () {
    var plain = discordAnnouncements.buildPayload({
      title: "x".repeat(300),
      description: "@everyone y".repeat(1000),
      url: "javascript:alert(1)",
      color: "#4f46e5",
    });
    assert.equal(plain.embeds[0].title.length, 256);
    assert.equal(plain.embeds[0].description.length, 4096);
    assert.equal(plain.embeds[0].url, undefined, "only http(s) links");
    assert.equal(plain.embeds[0].color, 0x4f46e5);
    assert.deepEqual(plain.allowed_mentions, { parse: [] });
    assert.equal(plain.content, undefined);

    var loud = discordAnnouncements.buildPayload({ title: "T", description: "D", mentionEveryone: true, url: "https://x.test/a" });
    assert.deepEqual(loud.allowed_mentions, { parse: ["everyone"] });
    assert.equal(loud.content, "@everyone");
    assert.equal(loud.embeds[0].url, "https://x.test/a");
  });

  await t.test("a 429 is retried after retry_after; unset webhooks are skipped", async function (t2) {
    await reset();
    var discord = fakeDiscord(t2);
    discord.queue.push({ status: 429, retryAfter: 0.02 });
    var started = Date.now();
    var outcome = await discordAnnouncements.send("discord_announcements", { title: "T", description: "D" });
    assert.equal(outcome.status, "sent");
    assert.equal(outcome.attempts, 2);
    assert.ok(Date.now() - started >= 15, "waited for retry_after");
    assert.equal(discord.posts.length, 2);
    assert.match(discord.posts[0].url, /^https:\/\/discord\.test\/api\/webhooks\/1\/announce\?wait=true$/);

    discord.queue.push({ status: 429 }, { status: 429 }, { status: 429 });
    var limited = await discordAnnouncements.send("discord_announcements", { title: "T", description: "D" });
    assert.equal(limited.status, "failed");
    assert.equal(limited.attempts, 3);

    delete process.env.DISCORD_WORKSHOPS_WEBHOOK_URL;
    var skipped = await discordAnnouncements.send("discord_workshops", { title: "T", description: "D" });
    assert.equal(skipped.status, "skipped");
  });

  await t.test("send now to email and both channels: consent-aware email, recorded Discord posts", async function (t2) {
    await reset();
    var mail = flaky.mockFlakyTransport(t2);
    var discord = fakeDiscord(t2);
    var mod = await fixtures.createUser({ role: "moderator", name: "Mo" });
    var round = await ApplicationRound.create({ name: "General", isOpen: true });
    var yes = await fixtures.createUser({ email: "yes@example.com", name: "Yes", marketingEmailConsent: true });
    var no = await fixtures.createUser({
      email: "no@example.com",
      name: "No",
      marketingEmailConsent: false,
      emailPreferences: { announcements: false },
    });
    await Application.create({ applicant: yes.user._id, round: round._id, name: "Yes", status: "accepted" });
    await Application.create({ applicant: no.user._id, round: round._id, name: "No", status: "accepted" });

    var overview = await request(app).get("/api/staff/communications").set(as(mod));
    assert.equal(overview.status, 200);
    assert.deepEqual(overview.body.channels, { email: true, discord_announcements: true, discord_workshops: true, workshops: true });
    assert.equal(overview.body.canEditSettings, false);
    assert.ok(overview.body.audiences.some(function (a) { return a.key === "workshop"; }));
    assert.ok(!overview.body.audiences.some(function (a) { return a.key === "workshop_signups"; }));

    var body = {
      title: "Dinner is ready",
      message: "Dinner is in the main hall. Menu: https://example.com/menu",
      url: "https://example.com/menu",
      channels: ["email", "discord_announcements", "discord_workshops"],
      audience: { segment: "accepted" },
    };
    var preview = await request(app).post("/api/staff/communications/preview").set(as(mod)).send(body);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.email.subject, "Dinner is ready");
    assert.match(preview.body.email.html, /<a href="https:\/\/example.com\/menu">/);
    assert.equal(preview.body.discord.embeds[0].title, "Dinner is ready");
    assert.deepEqual(preview.body.audience, { label: "Accepted", inAudience: 2, recipients: 1, skippedOptOut: 1 });
    assert.equal(discord.posts.length, 0, "preview posts nothing");
    assert.equal(await EmailLog.countDocuments({}), 0, "preview sends nothing");

    var res = await request(app).post("/api/staff/communications/announcements").set(as(mod)).send(body);
    assert.equal(res.status, 201);
    var a = res.body.announcement;
    assert.equal(a.status, "sent");
    assert.deepEqual(a.emailCounts, { inAudience: 2, queued: 1, skippedOptOut: 1 });
    assert.deepEqual(a.discord.map(function (d) { return [d.channel, d.status, d.messageId]; }), [
      ["discord_announcements", "sent", "msg-1"],
      ["discord_workshops", "sent", "msg-2"],
    ]);
    assert.equal(discord.posts[0].url, ANNOUNCE_URL + "?wait=true");
    assert.equal(discord.posts[1].url, WORKSHOPS_URL + "?wait=true");
    assert.deepEqual(discord.posts[0].body.allowed_mentions, { parse: [] });
    assert.equal(discord.posts[0].body.embeds[0].description, body.message);
    assert.equal(discord.posts[0].body.embeds[0].url, "https://example.com/menu");

    await settle();
    assert.equal(mail.calls.length, 1);
    assert.equal(mail.calls[0].to, "yes@example.com");
    assert.equal(mail.calls[0].subject, "Dinner is ready");
    assert.match(mail.calls[0].text, /Hi Yes,\n\nDinner is in the main hall/);
    assert.match(mail.calls[0].headers["List-Unsubscribe"], /unsubscribe\?token=/);
    var row = await EmailLog.findOne({ to: "yes@example.com" });
    assert.equal(row.category, "announcement");
    assert.equal(row.batchId, "announcement:" + a.id);

    var history = await request(app).get("/api/staff/communications/announcements").set(as(mod));
    assert.equal(history.status, 200);
    assert.equal(history.body.total, 1);
    assert.equal(history.body.announcements[0].createdBy.name, "Mo");
    assert.equal(history.body.announcements[0].emailStatus.sent, 1);

    // A double click is refused; "send again" makes a new one.
    var again = await request(app).post("/api/staff/communications/announcements").set(as(mod)).send(body);
    assert.equal(again.status, 409);
    await Announcement.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 5 * MINUTE) } });
    var resend = await request(app).post("/api/staff/communications/announcements/" + a.id + "/send-again").set(as(mod)).send({});
    assert.equal(resend.status, 201);
    assert.equal(resend.body.announcement.resendOf, a.id);
    assert.equal(resend.body.announcement.status, "sent");
    assert.equal(discord.posts.length, 4);
  });

  await t.test("@everyone only with the toggle; Discord-only announcements need no audience", async function (t2) {
    await reset();
    var discord = fakeDiscord(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var res = await request(app)
      .post("/api/staff/communications/announcements")
      .set(as(admin))
      .send({ title: "Judging starts", message: "@here go to your tables", channels: ["discord_announcements"], mentionEveryone: true });
    assert.equal(res.status, 201);
    assert.deepEqual(discord.posts[0].body.allowed_mentions, { parse: ["everyone"] });
    assert.equal(discord.posts[0].body.content, "@everyone");

    // Email off: mentionEveryone means nothing without a Discord channel.
    var failed = await request(app)
      .post("/api/staff/communications/announcements")
      .set(as(admin))
      .send({ title: "Oops", message: "M", channels: ["discord_workshops"] });
    assert.equal(failed.status, 201);
    assert.deepEqual(discord.posts[1].body.allowed_mentions, { parse: [] });
  });

  await t.test("announcement email: accepted people get it unless they opt out; others only if they opted in", async function (t2) {
    await reset();
    var mail = flaky.mockFlakyTransport(t2);
    fakeDiscord(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var round = await ApplicationRound.create({ name: "General", isOpen: true });
    async function person(email, status, prefs) {
      var made = await fixtures.createUser(Object.assign({ email: email, name: email.split("@")[0] }, prefs || {}));
      await Application.create({ applicant: made.user._id, round: round._id, name: email, status: status });
      return made;
    }
    await person("unset-accepted@example.com", "accepted");
    var unsub = await person("unsub-accepted@example.com", "accepted");
    await person("optin-accepted@example.com", "accepted", { emailPreferences: { announcements: true } });
    await person("legacy-accepted@example.com", "accepted", { marketingEmailConsent: true });
    await person("unset-pending@example.com", "pending");
    await person("optin-pending@example.com", "pending", { emailPreferences: { announcements: true } });
    await person("unsub-pending@example.com", "pending", { emailPreferences: { announcements: false } });

    // The unsubscribe link records an explicit "no".
    var link = new URL(require("../utils/unsubscribe").link(unsub.user._id));
    var off = await request(app)
      .post("/api/auth/unsubscribe")
      .send({ u: link.searchParams.get("u"), t: link.searchParams.get("t") });
    assert.equal(off.status, 200);
    var stored = await User.findById(unsub.user._id).lean();
    assert.equal(stored.emailPreferences.announcements, false);
    assert.equal(stored.marketingEmailConsent, false);

    var acceptedBody = { title: "Hello", message: "News", channels: ["email"], audience: { segment: "accepted" } };
    var preview = await request(app).post("/api/staff/communications/preview").set(as(admin)).send(acceptedBody);
    assert.deepEqual(preview.body.audience, { label: "Accepted", inAudience: 4, recipients: 3, skippedOptOut: 1 });
    var pendingBody = { title: "Hello again", message: "More news", channels: ["email"], audience: { segment: "pending" } };
    var pendingPreview = await request(app).post("/api/staff/communications/preview").set(as(admin)).send(pendingBody);
    assert.deepEqual(pendingPreview.body.audience, { label: "Applied, no decision yet", inAudience: 3, recipients: 1, skippedOptOut: 2 });

    assert.equal((await request(app).post("/api/staff/communications/announcements").set(as(admin)).send(acceptedBody)).status, 201);
    assert.equal((await request(app).post("/api/staff/communications/announcements").set(as(admin)).send(pendingBody)).status, 201);
    await settle();
    assert.deepEqual(
      mail.calls.map(function (m) { return m.to; }).sort(),
      ["legacy-accepted@example.com", "optin-accepted@example.com", "optin-pending@example.com", "unset-accepted@example.com"]
    );

    // Checked again when the email is actually sent: opting out while it waits stops it.
    var late = await User.findOne({ email: "unset-accepted@example.com" });
    await outbox.enqueueMany(
      [{ to: late.email, user: late._id, templateKey: "announcement", category: "announcement", values: { title: "T", message: "M", name: "x" } }],
      { batchId: "late-test" }
    );
    await User.updateOne({ _id: late._id }, { $set: { "emailPreferences.announcements": false } });
    await settle();
    var cancelled = await EmailLog.findOne({ to: late.email, status: "cancelled" });
    assert.ok(cancelled);
    assert.match(cancelled.lastError, /unsubscribed|opted in/);

    // What the person sees in their preferences matches.
    var fresh = await fixtures.createUser({ email: "fresh@example.com" });
    await Application.create({ applicant: fresh.user._id, round: round._id, name: "Fresh", status: "accepted" });
    var prefs = await request(app).get("/api/auth/me/email-preferences").set(as(fresh));
    assert.equal(prefs.body.preferences.announcements, true);
    var turned = await request(app).put("/api/auth/me/email-preferences").set(as(fresh)).send({ announcements: false });
    assert.equal(turned.body.preferences.announcements, false);
    assert.equal((await User.findById(fresh.user._id).lean()).emailPreferences.announcements, false);
  });

  await t.test("separate Discord text: @tags become role mentions and only those ping", async function (t2) {
    await reset();
    flaky.mockFlakyTransport(t2);
    var discord = fakeDiscord(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var mod = await fixtures.createUser({ role: "moderator" });
    await CommunicationSettings.getSingleton();
    await CommunicationSettings.updateOne(
      { key: "default" },
      {
        $set: {
          discordTags: [
            { label: "participants", roleId: "123456789012345678" },
            { label: "workshop", roleId: "98765432109876543" },
          ],
        },
      }
    );

    var resolved = discordAnnouncements.resolveMentions(
      "Hi @participants, @Everyone and @here; mail me at a@b.com, ask @mentors. Also <@&555555555555555555> and @workshop-x",
      [{ label: "participants", roleId: "123456789012345678" }]
    );
    assert.equal(
      resolved.text,
      "Hi <@&123456789012345678>, @everyone and @here; mail me at a@b.com, ask @mentors. Also <@&555555555555555555> and @workshop-x"
    );
    assert.deepEqual(resolved.roleIds, ["123456789012345678"]);
    assert.deepEqual(resolved.labels, ["@participants", "@everyone", "@here"]);

    // Plain text post (no Discord title): email text and Discord text differ.
    var body = {
      title: "Subject for email",
      message: "Long email body.",
      discordMessage: "Dinner time @participants and @everyone! @nobody https://example.com/menu",
      channels: ["email", "discord_announcements"],
      audience: { segment: "test_to_me" },
    };
    var preview = await request(app).post("/api/staff/communications/preview").set(as(mod)).send(body);
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.pings, ["@participants", "@everyone"]);
    assert.equal(preview.body.email.subject, "Subject for email");
    assert.equal(preview.body.discord.content, "Dinner time <@&123456789012345678> and @everyone! @nobody https://example.com/menu");
    assert.equal(discord.posts.length, 0);

    var sent = await request(app).post("/api/staff/communications/announcements").set(as(mod)).send(body);
    assert.equal(sent.status, 201);
    assert.equal(discord.posts.length, 1);
    var payload = discord.posts[0].body;
    assert.equal(payload.content, "Dinner time <@&123456789012345678> and @everyone! @nobody https://example.com/menu");
    assert.equal(payload.embeds, undefined);
    assert.deepEqual(payload.allowed_mentions, { parse: ["everyone"], roles: ["123456789012345678"] });
    assert.equal(sent.body.announcement.discordMessage, body.discordMessage);

    // With an embed title the pings go above it and the embed has the text.
    var embedded = await request(app)
      .post("/api/staff/communications/announcements")
      .set(as(admin))
      .send({ title: "x", message: "y", discordTitle: "Workshop time", discordMessage: "Go to @workshop now", channels: ["discord_workshops"] });
    assert.equal(embedded.status, 201);
    var second = discord.posts[1].body;
    assert.equal(second.content, "<@&98765432109876543>");
    assert.equal(second.embeds[0].title, "Workshop time");
    assert.equal(second.embeds[0].description, "Go to <@&98765432109876543> now");
    assert.deepEqual(second.allowed_mentions, { parse: [], roles: ["98765432109876543"] });

    // Discord-only needs no email subject; nothing typed means nobody is pinged.
    var quiet = await request(app)
      .post("/api/staff/communications/announcements")
      .set(as(admin))
      .send({ discordMessage: "Sponsor session in room 5 at 3 PM, ping <@123456789012345678> not", channels: ["discord_workshops"] });
    assert.equal(quiet.status, 201);
    assert.deepEqual(discord.posts[2].body.allowed_mentions, { parse: [] });
    assert.match(discord.posts[2].body.content, /^Sponsor session in room 5/);
    assert.match(quiet.body.announcement.title, /^Sponsor session/);

    // Limits: plain text 2000, with a title 4096; empty text is an error.
    function post(extra) {
      return request(app).post("/api/staff/communications/announcements").set(as(admin)).send(Object.assign({ channels: ["discord_workshops"] }, extra));
    }
    var tooLong = await post({ discordMessage: "x".repeat(2001) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.field, "discordMessage");
    assert.equal((await post({ discordMessage: "x".repeat(2001), discordTitle: "T" })).status, 201);
    assert.equal((await post({ discordMessage: "   " })).body.field, "discordMessage");
    assert.equal((await post({ discordMessage: "ok", discordTitle: "t".repeat(257) })).body.field, "discordTitle");
    // An email-only post still needs its subject and body.
    var needsEmail = await request(app)
      .post("/api/staff/communications/announcements")
      .set(as(admin))
      .send({ discordMessage: "hi", channels: ["email", "discord_workshops"], audience: { segment: "test_to_me" } });
    assert.equal(needsEmail.body.field, "title");
  });

  await t.test("validation: fields, unconfigured channels, audiences, times", async function (t2) {
    await reset();
    fakeDiscord(t2);
    var mod = await fixtures.createUser({ role: "moderator" });
    function post(body) {
      return request(app).post("/api/staff/communications/announcements").set(as(mod)).send(body);
    }
    var base = { title: "T", message: "M", channels: ["discord_announcements"] };
    assert.equal((await post(Object.assign({}, base, { title: "" }))).body.field, "title");
    assert.equal((await post(Object.assign({}, base, { title: "x".repeat(257) }))).status, 400);
    assert.equal((await post(Object.assign({}, base, { message: "x".repeat(4097) }))).status, 400);
    assert.equal((await post(Object.assign({}, base, { url: "ftp://x" }))).body.field, "url");
    assert.equal((await post(Object.assign({}, base, { channels: [] }))).body.field, "channels");
    assert.equal((await post(Object.assign({}, base, { channels: ["sms"] }))).status, 400);
    assert.equal((await post(Object.assign({}, base, { channels: ["email"] }))).body.field, "audience");
    assert.equal((await post(Object.assign({}, base, { channels: ["email"], audience: { segment: "workshop" } }))).body.field, "audience");
    assert.equal((await post(Object.assign({}, base, { scheduledFor: new Date(Date.now() - MINUTE).toISOString() }))).body.field, "scheduledFor");
    assert.equal((await post(Object.assign({}, base, { scheduledFor: "not a date" }))).status, 400);
    delete process.env.DISCORD_ANNOUNCEMENTS_WEBHOOK_URL;
    var unset = await post(base);
    assert.equal(unset.status, 400);
    assert.match(unset.body.error, /Technical settings/);
    assert.equal(await Announcement.countDocuments({}), 0);
  });

  await t.test("schedule, cancel, and the scheduler sends a due one exactly once", async function (t2) {
    await reset();
    var discord = fakeDiscord(t2);
    var mod = await fixtures.createUser({ role: "moderator" });
    var later = new Date(Date.now() + 60 * MINUTE).toISOString();
    var first = await request(app)
      .post("/api/staff/communications/announcements")
      .set(as(mod))
      .send({ title: "Later", message: "M", channels: ["discord_announcements"], scheduledFor: later });
    assert.equal(first.status, 201);
    assert.equal(first.body.announcement.status, "scheduled");
    assert.equal(discord.posts.length, 0);

    var next = await communications.upcoming();
    assert.equal(next[0].kind, "announcement");
    assert.equal(next[0].label, "Later");

    var cancel = await request(app).post("/api/staff/communications/announcements/" + first.body.announcement.id + "/cancel").set(as(mod));
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.announcement.status, "cancelled");
    assert.equal((await request(app).post("/api/staff/communications/announcements/" + first.body.announcement.id + "/cancel").set(as(mod))).status, 409);

    var second = await request(app)
      .post("/api/staff/communications/announcements")
      .set(as(mod))
      .send({ title: "Soon", message: "M2", channels: ["discord_announcements"], scheduledFor: later });
    await Announcement.updateOne({ _id: second.body.announcement.id }, { $set: { scheduledFor: new Date(Date.now() - 1000) } });
    // Two processes at once: only one claims it.
    await Promise.all([communications.sendDueAnnouncements(), communications.sendDueAnnouncements()]);
    await communications.tick();
    assert.equal(discord.posts.length, 1);
    var sent = await Announcement.findById(second.body.announcement.id);
    assert.equal(sent.status, "sent");
    assert.equal(sent.discord[0].status, "sent");

    // One left "sending" by a crash is marked failed, never sent twice.
    await Announcement.create({
      title: "Stuck",
      message: "M",
      channels: ["discord_announcements"],
      status: "sending",
      lockedUntil: new Date(Date.now() - 1000),
    });
    await communications.sendDueAnnouncements();
    var stuck = await Announcement.findOne({ title: "Stuck" });
    assert.equal(stuck.status, "failed");
    assert.match(stuck.error, /Interrupted/);
    assert.equal(discord.posts.length, 1);
  });

  await t.test("audiences: workshop sign-ups and checked in only", async function (t2) {
    await reset();
    flaky.mockFlakyTransport(t2);
    fakeDiscord(t2);
    var mod = await fixtures.createUser({ role: "moderator" });
    var a = await fixtures.createUser({ email: "a@example.com", marketingEmailConsent: true, checkedIn: true });
    var b = await fixtures.createUser({ email: "b@example.com", marketingEmailConsent: true });
    await fixtures.createUser({ email: "c@example.com", marketingEmailConsent: true, checkedIn: true });
    var workshop = await workshopIn(600, [a, b]);

    var body = { title: "Room change", message: "M", channels: ["email"], audience: { segment: "workshop", workshop: String(workshop._id) } };
    var all = await request(app).post("/api/staff/communications/preview").set(as(mod)).send(body);
    assert.equal(all.body.audience.recipients, 2);
    assert.equal(all.body.audience.label, "Signed up for Hackathon Playbook");
    body.audience.checkedInOnly = true;
    var here = await request(app).post("/api/staff/communications/preview").set(as(mod)).send(body);
    assert.equal(here.body.audience.recipients, 1);
    assert.equal(here.body.audience.label, "Signed up for Hackathon Playbook (checked in only)");

    var checked = await request(app)
      .post("/api/staff/communications/preview")
      .set(as(mod))
      .send({ title: "T", message: "M", channels: ["email"], audience: { segment: "checked_in" } });
    assert.equal(checked.body.audience.recipients, 2);

    var sent = await request(app).post("/api/staff/communications/announcements").set(as(mod)).send(body);
    assert.equal(sent.body.announcement.emailCounts.queued, 1);
    await settle();
    assert.deepEqual(await EmailLog.distinct("to", { templateKey: "announcement" }), ["a@example.com"]);
  });

  await t.test("automation settings: admins only, validated", async function () {
    await reset();
    var admin = await fixtures.createUser({ role: "admin" });
    var mod = await fixtures.createUser({ role: "moderator" });
    function patch(who, body) {
      return request(app).patch("/api/staff/communications/settings").set(as(who)).send(body);
    }
    var defaults = (await request(app).get("/api/staff/communications").set(as(admin))).body.settings;
    assert.deepEqual(defaults.reminderAll, { discord: true, email: true, offsets: [120] });
    assert.deepEqual(defaults.reminderSignedUp, { email: true, discord: false, offsets: [45, 5] });
    assert.deepEqual(defaults.discordTags, []);
    assert.deepEqual(defaults.workshopMention, { enabled: false, tag: "" });
    assert.equal(defaults.digestDiscord.enabled, true);
    assert.equal(defaults.digestEmail.enabled, false);
    assert.equal(defaults.updatesDiscord.enabled, true);

    assert.equal((await patch(mod, { digestEmail: { enabled: true } })).status, 403);
    var ok = await patch(admin, { reminderAll: { offsets: [30, 180] }, digestDiscord: { time: "18:30", windowHours: 12 } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.settings.reminderAll, { discord: true, email: true, offsets: [180, 30] });
    assert.equal(ok.body.settings.digestDiscord.time, "18:30");
    assert.ok(Array.isArray(ok.body.next));

    assert.equal((await patch(admin, { reminderAll: { offsets: [0] } })).status, 400);
    assert.equal((await patch(admin, { reminderAll: { offsets: ["45"] } })).status, 400);
    assert.equal((await patch(admin, { reminderAll: { offsets: [5, 5] } })).status, 400);
    assert.equal((await patch(admin, { reminderSignedUp: { offsets: [1, 2, 3, 4, 5, 6, 7] } })).status, 400);
    assert.equal((await patch(admin, { digestDiscord: { time: "25:00" } })).status, 400);
    assert.equal((await patch(admin, { reminderAll: { email: "yes" } })).status, 400);
    assert.equal((await patch(admin, { surprise: { enabled: true } })).status, 400);
    assert.equal((await patch(admin, { reminderAll: { volume: 3 } })).status, 400);
    assert.equal((await patch(admin, {})).status, 400);
    assert.deepEqual((await CommunicationSettings.getSingleton()).reminderAll.offsets.toObject(), [180, 30]);

    // Discord mention tags: lowercase, unique, numeric role ids; moderators can't edit them.
    var tags = [
      { label: "participants", roleId: "123456789012345678" },
      { label: "workshop", roleId: "98765432109876543" },
    ];
    assert.equal((await patch(mod, { discordTags: tags })).status, 403);
    var saved = await patch(admin, { discordTags: tags, workshopMention: { enabled: true, tag: "workshop" } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.settings.discordTags, tags);
    assert.deepEqual(saved.body.settings.workshopMention, { enabled: true, tag: "workshop" });
    assert.equal((await patch(admin, { discordTags: [{ label: "Big Team", roleId: "123456789012345678" }] })).status, 400);
    assert.equal((await patch(admin, { discordTags: [{ label: "everyone", roleId: "123456789012345678" }] })).status, 400);
    assert.equal((await patch(admin, { discordTags: [{ label: "a", roleId: "12345" }] })).status, 400);
    assert.equal((await patch(admin, { discordTags: [{ label: "a", roleId: "1234567890123456789a" }] })).status, 400);
    assert.equal(
      (await patch(admin, { discordTags: [{ label: "a", roleId: "123456789012345678" }, { label: "a", roleId: "123456789012345679" }] })).status,
      400
    );
    assert.equal((await patch(admin, { workshopMention: { tag: "Not Valid" } })).status, 400);
    var overview = await request(app).get("/api/staff/communications").set(as(mod));
    assert.deepEqual(overview.body.settings.discordTags, tags, "moderators can see the tags to use them");
  });

  await t.test("2 hour announcement: Discord post and one email per accepted person, combined and once", async function (t2) {
    await reset();
    var mail = flaky.mockFlakyTransport(t2);
    var discord = fakeDiscord(t2);
    var round = await ApplicationRound.create({ name: "General", isOpen: true });
    var ada = await fixtures.createUser({ email: "ada@example.com", name: "Ada" });
    var bo = await fixtures.createUser({ email: "bo@example.com", name: "Bo", emailPreferences: { event: false } });
    var cy = await fixtures.createUser({ email: "cy@example.com", name: "Cy" });
    var dee = await fixtures.createUser({ email: "dee@example.com", name: "Dee" });
    await Application.create({ applicant: ada.user._id, round: round._id, name: "Ada", status: "accepted" });
    await Application.create({ applicant: bo.user._id, round: round._id, name: "Bo", status: "accepted" });
    await Application.create({ applicant: cy.user._id, round: round._id, name: "Cy", status: "accepted" });
    await Application.create({ applicant: dee.user._id, round: round._id, name: "Dee", status: "pending" });

    var startsAt = new Date(Date.now() + 100 * MINUTE);
    var one = await workshopIn(100, [], { title: "Intro to Git", startsAt: startsAt, endsAt: new Date(startsAt.getTime() + 60 * MINUTE), capacity: 10, signupCount: 4 });
    await workshopIn(100, [], { title: "Intro to React", startsAt: startsAt, endsAt: new Date(startsAt.getTime() + 60 * MINUTE) });
    await workshopIn(100, [], { title: "Draft", published: false, startsAt: startsAt });
    await workshopIn(100, [], { title: "Gone", cancelled: true, startsAt: startsAt });
    await workshopIn(300, [], { title: "Much later" });

    var next = await communications.upcoming();
    var combined = next.find(function (item) { return item.scope === "all" && /2 workshops/.test(item.label); });
    assert.ok(combined, "the two workshops starting together show as one item");
    assert.deepEqual(combined.channels, ["email", "discord_workshops"]);
    assert.equal(combined.recipients, 2, "Bo turned event email off");
    assert.equal(combined.offset, 120);

    await Promise.all([communications.runWorkshopAutomations(), communications.runWorkshopAutomations()]);
    await communications.runWorkshopAutomations();
    await settle();

    assert.equal(discord.posts.length, 1, "one combined post");
    var embed = discord.posts[0].body.embeds[0];
    assert.match(embed.title, /^Workshops starting at /);
    assert.match(embed.description, /Intro to Git[\s\S]*Room 101[\s\S]*Host: Sam[\s\S]*6 spots left\.[\s\S]*Sign up: http/);
    assert.match(embed.description, /Intro to React/);
    assert.doesNotMatch(embed.description, /Draft|Gone|Much later/);
    assert.equal(discord.posts[0].url, WORKSHOPS_URL + "?wait=true");
    assert.deepEqual(discord.posts[0].body.allowed_mentions, { parse: [] });

    var announcements = await EmailLog.find({ templateKey: "workshop_announcement" }).lean();
    assert.deepEqual(announcements.map(function (r) { return r.to; }).sort(), ["ada@example.com", "cy@example.com"]);
    assert.equal(announcements[0].status, "sent");
    assert.match(announcements[0].values.headline, /2 workshops/);
    assert.match(announcements[0].values.workshops, /Intro to Git[\s\S]*Intro to React/);
    assert.equal(mail.calls.length, 2);

    // A workshop moved to a new time is announced again for the new time.
    var moved = new Date(Date.now() + 90 * MINUTE);
    await Workshop.updateOne({ _id: one._id }, { $set: { startsAt: moved, endsAt: new Date(moved.getTime() + 60 * MINUTE) } });
    await communications.runWorkshopAutomations();
    await settle();
    assert.equal(discord.posts.length, 2);
    assert.equal(await EmailLog.countDocuments({ templateKey: "workshop_announcement" }), 4);

    // A bigger lead is a different send; clearing the offsets stops it all.
    await CommunicationSettings.updateOne({ key: "default" }, { $set: { "reminderAll.offsets": [] } });
    await workshopIn(60, [], { title: "Next one" });
    await communications.runWorkshopAutomations();
    assert.equal(discord.posts.length, 2);
  });

  await t.test("signed-up reminders at 45 and 5 minutes, with their own wording, once per person", async function (t2) {
    await reset();
    var mail = flaky.mockFlakyTransport(t2);
    var discord = fakeDiscord(t2);
    var a = await fixtures.createUser({ email: "a@example.com", name: "Ada" });
    var b = await fixtures.createUser({ email: "b@example.com", name: "Bo" });
    var c = await fixtures.createUser({ email: "c@example.com", name: "Cy" });
    var soon = await workshopIn(44, [a, b]);
    var far = await workshopIn(180, [a]);
    var hidden = await workshopIn(20, [a], { published: false, title: "Draft" });
    var gone = await workshopIn(20, [a], { cancelled: true, title: "Gone" });
    await CommunicationSettings.getSingleton();
    await CommunicationSettings.updateOne({ key: "default" }, { $set: { "reminderAll.offsets": [] } });

    var next = await communications.upcoming();
    var items = next.filter(function (item) { return item.workshop === String(soon._id); });
    assert.deepEqual(items.map(function (i) { return [i.offset, i.recipients]; }), [[45, 2], [5, 2]]);

    // Two schedulers at once still send each reminder once.
    await Promise.all([communications.runWorkshopAutomations(), communications.runWorkshopAutomations()]);
    await communications.runWorkshopAutomations();
    await settle();
    var reminders = await EmailLog.find({ templateKey: "workshop_reminder" }).lean();
    assert.deepEqual(reminders.map(function (r) { return r.to; }).sort(), ["a@example.com", "b@example.com"]);
    assert.match(reminders[0].values.headline, /^Starting in (44|45) minutes$/);
    assert.match(reminders[0].values.lead, /^starts in (44|45) minutes$/);
    assert.equal(reminders[0].values.title, "Hackathon Playbook");
    assert.match(reminders[0].values.workshopUrl, new RegExp("/dashboard/workshops/" + soon._id + "$"));
    assert.equal(discord.posts.length, 0, "Discord at these offsets is off by default");
    assert.equal(await AutomationLog.countDocuments({ workshop: { $in: [hidden._id, gone._id, far._id] } }), 0);

    // A late sign-up gets their own reminder, nobody else gets a second.
    await Signup.create({ user: c.user._id, workshop: soon._id });
    await communications.runWorkshopAutomations();
    await settle();
    assert.equal(await EmailLog.countDocuments({ templateKey: "workshop_reminder" }), 3);

    // Five minutes before: the "starting now" wording, once more for each.
    await communications.runWorkshopAutomations(new Date(Date.now() + 40 * MINUTE));
    await communications.runWorkshopAutomations(new Date(Date.now() + 41 * MINUTE));
    await settle();
    var rows = await EmailLog.find({ templateKey: "workshop_reminder", "values.headline": "Starting now" }).lean();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].values.lead, "is starting now in Room 101");
    assert.equal(mail.calls.filter(function (m) { return /^Starting now: /.test(m.subject); }).length, 3);

    // Moved: reminders again for the new time.
    var moved = new Date(Date.now() + 40 * MINUTE);
    await Workshop.updateOne({ _id: soon._id }, { $set: { startsAt: moved, endsAt: new Date(moved.getTime() + 60 * MINUTE) } });
    await communications.runWorkshopAutomations();
    await settle();
    assert.equal(await EmailLog.countDocuments({ templateKey: "workshop_reminder" }), 9);

    // Someone who turned event email off is skipped at send time.
    var late = await workshopIn(10, [a], { title: "Late night" });
    await User.updateOne({ _id: a.user._id }, { $set: { "emailPreferences.event": false } });
    await communications.runWorkshopAutomations();
    await settle();
    var skipped = await EmailLog.findOne({ templateKey: "workshop_reminder", "values.title": "Late night" });
    assert.equal(skipped.status, "cancelled");
    assert.ok(late);
  });

  await t.test("signed-up reminders can also post to Discord, and automated posts can mention a tag", async function (t2) {
    await reset();
    flaky.mockFlakyTransport(t2);
    var discord = fakeDiscord(t2);
    var a = await fixtures.createUser({ email: "a@example.com" });
    await workshopIn(4, [a]);
    await CommunicationSettings.getSingleton();
    await CommunicationSettings.updateOne(
      { key: "default" },
      {
        $set: {
          "reminderAll.offsets": [],
          "reminderSignedUp.discord": true,
          "reminderSignedUp.email": false,
          discordTags: [{ label: "workshop", roleId: "98765432109876543" }],
          "workshopMention.enabled": true,
          "workshopMention.tag": "workshop",
        },
      }
    );
    await communications.runWorkshopAutomations();
    await communications.runWorkshopAutomations();
    assert.equal(discord.posts.length, 1);
    assert.match(discord.posts[0].body.embeds[0].title, /^Starting now: Hackathon Playbook$/);
    assert.equal(discord.posts[0].body.content, "<@&98765432109876543>");
    assert.deepEqual(discord.posts[0].body.allowed_mentions, { parse: [], roles: ["98765432109876543"] });
  });

  await t.test("automations stay off without the workshops module or a channel", async function (t2) {
    await reset();
    flaky.mockFlakyTransport(t2);
    var discord = fakeDiscord(t2);
    var a = await fixtures.createUser({ email: "a@example.com" });
    await workshopIn(30, [a]);
    var OrgSettings = require("../schemas/orgSettings");
    await OrgSettings.create({ key: "default", features: { workshops: false } });
    await communications.runWorkshopAutomations();
    assert.equal(await AutomationLog.countDocuments({}), 0);
    await OrgSettings.updateOne({ key: "default" }, { $set: { "features.workshops": true } });

    delete process.env.DISCORD_WORKSHOPS_WEBHOOK_URL;
    await CommunicationSettings.getSingleton();
    await CommunicationSettings.updateOne({ key: "default" }, { $set: { "reminderAll.email": false, "reminderSignedUp.email": false } });
    await communications.runWorkshopAutomations();
    assert.equal(await AutomationLog.countDocuments({}), 0);
    assert.equal(discord.posts.length, 0);
    assert.deepEqual(
      (await communications.upcoming()).filter(function (i) { return i.kind !== "announcement"; }),
      []
    );
  });

  await t.test("the daily digest posts once a day, and emails opted-in accepted people when on", async function (t2) {
    await reset();
    flaky.mockFlakyTransport(t2);
    var discord = fakeDiscord(t2);
    var round = await ApplicationRound.create({ name: "General", isOpen: true });
    var fan = await fixtures.createUser({ email: "fan@example.com", marketingEmailConsent: true });
    var quiet = await fixtures.createUser({
      email: "quiet@example.com",
      marketingEmailConsent: false,
      emailPreferences: { announcements: false },
    });
    await Application.create({ applicant: fan.user._id, round: round._id, name: "Fan", status: "accepted" });
    await Application.create({ applicant: quiet.user._id, round: round._id, name: "Quiet", status: "accepted" });
    await workshopIn(300, [], { title: "Intro to React", capacity: 10, signupCount: 4 });
    await workshopIn(400, [], { title: "Full one", capacity: 2, signupCount: 2 });

    var now = new Date();
    var p = communications.zonedParts(now);
    var hhmm = String(p.hour).padStart(2, "0") + ":" + String(p.minute).padStart(2, "0");
    await CommunicationSettings.getSingleton();
    await CommunicationSettings.updateOne(
      { key: "default" },
      { $set: { "digestDiscord.time": hhmm, "digestEmail.enabled": true, "reminderAll.discord": false } }
    );

    await Promise.all([communications.runWorkshopAutomations(now), communications.runWorkshopAutomations(now)]);
    await communications.runWorkshopAutomations(new Date(now.getTime() + 5 * MINUTE));
    await settle();
    assert.equal(discord.posts.length, 1);
    var digest = discord.posts[0].body.embeds[0];
    assert.equal(digest.title, "Workshops coming up");
    assert.match(digest.description, /- Intro to React, .* in Room 101 \(6 spots left\)/);
    assert.doesNotMatch(digest.description, /Full one/);
    var emails = await EmailLog.find({ templateKey: "workshop_digest" }).lean();
    assert.deepEqual(emails.map(function (e) { return e.to; }), ["fan@example.com"]);
    assert.match(emails[0].values.workshops, /Intro to React/);

    // Too long after the configured time: not sent (tomorrow's will be).
    await AutomationLog.deleteMany({});
    await communications.runWorkshopAutomations(new Date(now.getTime() + 3 * 60 * MINUTE));
    assert.equal(discord.posts.length, 1);
  });

  await t.test("publishing or moving a workshop posts to the workshops channel", async function (t2) {
    await reset();
    flaky.mockFlakyTransport(t2);
    var discord = fakeDiscord(t2);
    var admin = await fixtures.createUser({ role: "admin" });
    var startsAt = new Date(Date.now() + 24 * 60 * MINUTE);
    var created = await request(app)
      .post("/api/admin/workshops")
      .set(as(admin))
      .send({ title: "Intro to Git", host: "Lee", location: "Room 2", startsAt: startsAt, endsAt: new Date(startsAt.getTime() + 60 * MINUTE) });
    assert.equal(created.status, 201);
    var id = created.body.workshop._id;
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(discord.posts.length, 0, "drafts are not posted");

    await request(app).patch("/api/admin/workshops/" + id).set(as(admin)).send({ published: true });
    await waitForPosts(discord, 1);
    assert.match(discord.posts[0].body.embeds[0].title, /^New workshop: Intro to Git$/);
    assert.match(discord.posts[0].body.embeds[0].description, /Where: Room 2/);

    await request(app).patch("/api/admin/workshops/" + id).set(as(admin)).send({ description: "Only text" });
    await request(app).patch("/api/admin/workshops/" + id).set(as(admin)).send({ location: "Room 3" });
    await waitForPosts(discord, 2);
    assert.match(discord.posts[1].body.embeds[0].title, /^Workshop moved: Intro to Git$/);
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(discord.posts.length, 2, "a description edit posts nothing");

    await CommunicationSettings.updateOne({ key: "default" }, { $set: { "updatesDiscord.enabled": false } });
    await request(app).patch("/api/admin/workshops/" + id).set(as(admin)).send({ location: "Room 4" });
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.equal(discord.posts.length, 2, "toggle off: no post");
  });

  delete process.env.DISCORD_ANNOUNCEMENTS_WEBHOOK_URL;
  delete process.env.DISCORD_WORKSHOPS_WEBHOOK_URL;
  await db.closeDatabase();
});

/**
 * Wait until the fake Discord has received `count` posts.
 * @param {object} discord - From fakeDiscord.
 * @param {number} count - Posts expected.
 * @returns {Promise<void>}
 */
async function waitForPosts(discord, count) {
  var started = Date.now();
  while (discord.posts.length < count) {
    if (Date.now() - started > 2000) {
      throw new Error("Expected " + count + " Discord posts, got " + discord.posts.length);
    }
    await new Promise(function (r) { setTimeout(r, 10); });
  }
}
