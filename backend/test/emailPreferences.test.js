"use strict";

process.env.AUTH_RATE_LIMIT_MAX = "500";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var flaky = require("./helpers/flakyMail");
var app = require("../server");
var mailer = require("../utils/mailer");
var outbox = require("../utils/outbox");
var emailCategories = require("../utils/emailCategories");
var unsubscribe = require("../utils/unsubscribe");
var EmailLog = require("../schemas/emailLog");
var EmailTemplate = require("../schemas/emailTemplate");
var ApplicationRound = require("../schemas/applicationRound");
var OrgSettings = require("../schemas/orgSettings");
var User = require("../schemas/user");

/**
 * @param {object} who - {token} from fixtures.createUser.
 * @returns {object} Header object for supertest .set().
 */
function as(who) {
  return { Authorization: "Bearer " + who.token };
}

/**
 * Fresh database with the built-in templates.
 * @returns {Promise<void>}
 */
async function reset() {
  outbox.resetBreaker();
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();
}

/**
 * @param {string} link - A /unsubscribe?token= link.
 * @returns {string} The token.
 */
function tokenOf(link) {
  return new URL(link).searchParams.get("token");
}

test("email preferences and unsubscribe", async function emailPreferences(t) {
  await db.connect();

  await t.test("every built-in template has a category; unknown keys are announcements", async function () {
    EmailTemplate.BUILT_IN_KEYS.forEach(function each(key) {
      assert.ok(emailCategories.TEMPLATE_CATEGORIES[key], key + " needs a category in utils/emailCategories");
    });
    assert.equal(emailCategories.forTemplate("password_reset"), "security");
    assert.equal(emailCategories.forTemplate("verify_email"), "security");
    assert.equal(emailCategories.forTemplate("judge_invite"), "security");
    assert.equal(emailCategories.forTemplate("application_accepted"), "decisions");
    assert.equal(emailCategories.forTemplate("application_waitlisted"), "decisions");
    assert.equal(emailCategories.forTemplate("account_setup"), "account");
    assert.equal(emailCategories.forTemplate("account_setup_reminder_2"), "account");
    assert.equal(emailCategories.forTemplate("workshop_reminder"), "event");
    assert.equal(emailCategories.forTemplate("hardware_return"), "event");
    assert.equal(emailCategories.forTemplate("announcement"), "announcements");
    assert.equal(emailCategories.forTemplate("my_custom_news"), "announcements");
    assert.equal(emailCategories.forRow({ templateKey: "application_accepted", category: "announcement" }), "announcements");
    assert.equal(emailCategories.forRow({ templateKey: "news", category: "test" }), "security");
    assert.equal(emailCategories.forRow({ templateKey: "news", category: "transactional", preferenceCategory: "event" }), "event");
  });

  await t.test("an opted-out category is cancelled with a reason; security email always sends", async function (t2) {
    await reset();
    var mail = flaky.mockFlakyTransport(t2);
    var person = await fixtures.createUser({
      email: "quiet@example.com",
      emailPreferences: { decisions: false, account: false, event: false },
      marketingEmailConsent: false,
    });

    await mailer.sendTemplateEmail("quiet@example.com", "application_accepted", { name: "Q" });
    await mailer.sendTemplateEmail("quiet@example.com", "workshop_signup", { name: "Q", title: "T" });
    await mailer.sendTemplateEmail("quiet@example.com", "verify_email", { name: "Q", verifyUrl: "http://x/verify?token=abc" }, { sensitive: true });
    await mailer.sendPasswordReset("quiet@example.com", "http://x/reset-password?token=abc");

    var sentTo = mail.calls.map(function (c) { return c.subject; });
    assert.equal(mail.calls.length, 2, "only the two security emails: " + sentTo.join(", "));
    mail.calls.forEach(function (c) {
      assert.equal(c.headers, undefined, "security email has no unsubscribe header");
      assert.doesNotMatch(c.text, /Unsubscribe:/);
    });
    var decision = await EmailLog.findOne({ templateKey: "application_accepted" });
    assert.equal(decision.status, "cancelled");
    assert.match(decision.lastError, /turned off application decision emails/);
    var event = await EmailLog.findOne({ templateKey: "workshop_signup" });
    assert.equal(event.status, "cancelled");
    assert.match(event.lastError, /event update emails/);

    // Turning event email back on lets the next one through, with its own link.
    await User.updateOne({ _id: person.user._id }, { $set: { "emailPreferences.event": true } });
    await mailer.sendTemplateEmail("quiet@example.com", "workshop_signup", { name: "Q", title: "T" });
    assert.equal(mail.calls.length, 3);
    var link = /Unsubscribe: (\S+)/.exec(mail.calls[2].text)[1];
    assert.deepEqual(unsubscribe.readToken(tokenOf(link)), { userId: String(person.user._id), category: "event" });
  });

  await t.test("a preference turned off while an email waits in the queue stops it at send time", async function (t2) {
    await reset();
    var mail = flaky.mockFlakyTransport(t2);
    var person = await fixtures.createUser({ email: "later@example.com" });
    await EmailLog.create({
      to: "later@example.com",
      user: person.user._id,
      templateKey: "hardware_reminder",
      values: { name: "L", itemName: "Arduino" },
      status: "queued",
      nextAttemptAt: new Date(Date.now() - 1000),
      maxAttempts: 6,
    });
    await User.updateOne({ _id: person.user._id }, { $set: { "emailPreferences.event": false } });
    await outbox.processDue({ force: true });
    assert.equal(mail.calls.length, 0);
    assert.equal((await EmailLog.findOne({ to: "later@example.com" })).status, "cancelled");
  });

  await t.test("List-Unsubscribe headers: one-click when API_PUBLIC_URL is set, page link otherwise", async function (t2) {
    await reset();
    var mail = flaky.mockFlakyTransport(t2);
    var person = await fixtures.createUser({ email: "headers@example.com" });
    var saved = process.env.API_PUBLIC_URL;
    try {
      process.env.API_PUBLIC_URL = "https://api.example.com/";
      await mailer.sendTemplateEmail("headers@example.com", "application_received", { name: "H" });
      delete process.env.API_PUBLIC_URL;
      await mailer.sendTemplateEmail("headers@example.com", "application_received", { name: "H" });
    } finally {
      if (saved === undefined) {
        delete process.env.API_PUBLIC_URL;
      } else {
        process.env.API_PUBLIC_URL = saved;
      }
    }
    var withApi = mail.calls[0].headers;
    assert.match(withApi["List-Unsubscribe"], /^<https:\/\/api\.example\.com\/api\/auth\/unsubscribe\/one-click\?token=[^>]+>, <http:\/\/localhost:3000\/unsubscribe\?token=[^>]+>$/);
    assert.equal(withApi["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    var withoutApi = mail.calls[1].headers;
    assert.match(withoutApi["List-Unsubscribe"], /^<http:\/\/localhost:3000\/unsubscribe\?token=/);
    assert.equal(withoutApi["List-Unsubscribe-Post"], undefined);
    assert.match(mail.calls[0].html, /Email preferences<\/a>/);

    // The one-click address works with nothing but the token.
    var oneClick = /<(https:\/\/api[^>]+)>/.exec(withApi["List-Unsubscribe"])[1];
    var token = decodeURIComponent(new URL(oneClick).searchParams.get("token"));
    var res = await request(app)
      .post("/api/auth/unsubscribe/one-click?token=" + encodeURIComponent(token))
      .type("form")
      .send("List-Unsubscribe=One-Click");
    assert.equal(res.status, 200);
    assert.equal(res.body.category, "decisions");
    assert.equal((await User.findById(person.user._id)).emailPreferences.decisions, false);
  });

  await t.test("the preferences page API: lookup, one category off, all off, back on, bad tokens", async function () {
    await reset();
    var person = await fixtures.createUser({ email: "page@example.com", marketingEmailConsent: true });
    var other = await fixtures.createUser({ email: "other@example.com", marketingEmailConsent: true });
    var token = tokenOf(unsubscribe.categoryLink(person.user._id, "event"));

    var look = await request(app).post("/api/auth/email-preferences/lookup").send({ token: token });
    assert.equal(look.status, 200);
    assert.equal(look.body.category, "event");
    assert.equal(look.body.email, "p***@example.com");
    assert.deepEqual(look.body.preferences, { decisions: true, account: true, event: true, announcements: true });
    assert.equal((await User.findById(person.user._id)).emailPreferences.event, true, "lookup changes nothing");

    var off = await request(app)
      .post("/api/auth/email-preferences/update")
      .send({ token: token, preferences: { event: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.preferences.event, false);
    assert.equal(off.body.preferences.decisions, true);

    var all = await request(app)
      .post("/api/auth/email-preferences/update")
      .send({ token: token, preferences: { decisions: false, account: false, event: false, announcements: false } });
    assert.equal(all.status, 200);
    var stored = await User.findById(person.user._id);
    assert.equal(stored.marketingEmailConsent, false, "announcements live in marketingEmailConsent");
    assert.equal(stored.emailPreferences.account, false);
    assert.ok(stored.emailPreferencesUpdatedAt);

    var back = await request(app)
      .post("/api/auth/email-preferences/update")
      .send({ token: token, preferences: { decisions: true, account: true, event: true, announcements: true } });
    assert.deepEqual(back.body.preferences, { decisions: true, account: true, event: true, announcements: true });

    // Bad input and bad tokens.
    assert.equal((await request(app).post("/api/auth/email-preferences/update").send({ token: token, preferences: { security: false } })).status, 400);
    assert.equal((await request(app).post("/api/auth/email-preferences/update").send({ token: token, preferences: { event: "no" } })).status, 400);
    assert.equal((await request(app).post("/api/auth/email-preferences/lookup").send({ token: "garbage" })).status, 400);
    var forged = token.split(".")[0] + "." + tokenOf(unsubscribe.categoryLink(other.user._id, "event")).split(".")[1];
    assert.equal((await request(app).post("/api/auth/email-preferences/lookup").send({ token: forged })).status, 400);
    var swapped = Buffer.from(JSON.stringify({ u: String(other.user._id), c: "event" })).toString("base64url") + "." + token.split(".")[1];
    assert.equal((await request(app).post("/api/auth/email-preferences/update").send({ token: swapped, preferences: { event: false } })).status, 400);
    assert.equal((await User.findById(other.user._id)).emailPreferences.event, true, "the other account is untouched");
    assert.equal((await request(app).post("/api/auth/email-preferences/lookup").send({})).status, 400);

    // A security link can't be used to switch anything off by one-click.
    var securityToken = unsubscribe.createToken(person.user._id, "security");
    assert.equal((await request(app).post("/api/auth/unsubscribe/one-click?token=" + encodeURIComponent(securityToken))).status, 400);

    // The old u/t links from earlier announcement emails still work.
    var legacy = new URL(unsubscribe.link(person.user._id));
    var old = await request(app)
      .post("/api/auth/unsubscribe")
      .send({ u: legacy.searchParams.get("u"), t: legacy.searchParams.get("t") });
    assert.equal(old.status, 200);
    assert.equal((await User.findById(person.user._id)).marketingEmailConsent, false);
  });

  await t.test("own preferences: GET and PUT /api/auth/me/email-preferences", async function () {
    await reset();
    var me = await fixtures.createUser({ email: "me@example.com" });

    var got = await request(app).get("/api/auth/me/email-preferences").set(as(me));
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.preferences, { decisions: true, account: true, event: true, announcements: false });
    assert.equal(got.body.categories.length, 5);
    assert.equal(got.body.categories[0].key, "security");
    assert.equal(got.body.categories[0].optional, false);

    var put = await request(app).put("/api/auth/me/email-preferences").set(as(me)).send({ announcements: true, decisions: false });
    assert.equal(put.status, 200);
    assert.equal(put.body.preferences.announcements, true);
    assert.equal(put.body.preferences.decisions, false);
    assert.equal((await User.findById(me.user._id)).marketingEmailConsent, true);

    assert.equal((await request(app).put("/api/auth/me/email-preferences").set(as(me)).send({ role: "admin" })).status, 400);
    assert.equal((await request(app).put("/api/auth/me/email-preferences").set(as(me)).send({})).status, 400);
    assert.equal((await request(app).put("/api/auth/me/email-preferences").send({ event: false })).status, 401);
  });

  await t.test("the application form's opt-in sets announcements and event email", async function (t2) {
    await reset();
    flaky.mockFlakyTransport(t2);
    await ApplicationRound.create({ name: "General", isOpen: true, formConfig: [] });
    await OrgSettings.create({ key: "default", publicApplications: true });

    var applicant = await fixtures.createUser({ email: "form@example.com", marketingEmailConsent: true });
    var draft = await request(app)
      .post("/api/applications")
      .set(as(applicant))
      .field("status", "draft")
      .field("name", "Form Person")
      .field("marketingEmailConsent", "false");
    assert.equal(draft.status, 200);
    var stored = await User.findById(applicant.user._id);
    assert.equal(stored.marketingEmailConsent, false);
    assert.equal(stored.emailPreferences.event, false);
    assert.equal(stored.emailPreferences.decisions, true, "decisions are not part of the checkbox");
    assert.ok(stored.emailPreferencesUpdatedAt);

    // Leaving the field out changes nothing.
    await request(app).post("/api/applications").set(as(applicant)).field("status", "draft").field("name", "Form Person");
    assert.equal((await User.findById(applicant.user._id)).emailPreferences.event, false);

    var pub = await request(app)
      .post("/api/applications/public")
      .field("email", "public@example.com")
      .field("name", "Public Person")
      .field("marketingEmailConsent", "true");
    assert.equal(pub.status, 201);
    var created = await User.findOne({ email: "public@example.com" });
    assert.equal(created.marketingEmailConsent, true);
    assert.equal(created.emailPreferences.event, true);
  });

  await t.test("staff see a person's preferences in attendee help", async function () {
    await reset();
    var staff = await fixtures.createUser({ role: "moderator" });
    await fixtures.createUser({ email: "lookup@example.com", emailPreferences: { event: false } });
    var res = await request(app).get("/api/staff/attendee?email=lookup@example.com").set(as(staff));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.attendee.emailPreferences, { decisions: true, account: true, event: false, announcements: false });
  });

  await db.closeDatabase();
});
