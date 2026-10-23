"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var db = require("./helpers/db");
var mailMock = require("./helpers/mailMock");
var mailer = require("../utils/mailer");
var EmailTemplate = require("../schemas/emailTemplate");

test("Email sends are paced (EMAIL_MIN_INTERVAL_MS)", async function pacing(t) {
  await db.connect();
  await db.clearDatabase();
  await EmailTemplate.seedDefaults();

  await t.test("a burst goes out one at a time with the minimum gap", async function (t2) {
    var mail = mailMock.mockTransport(t2);
    var previous = process.env.EMAIL_MIN_INTERVAL_MS;
    process.env.EMAIL_MIN_INTERVAL_MS = "150";
    t2.after(function restore() {
      process.env.EMAIL_MIN_INTERVAL_MS = previous;
    });

    var started = Date.now();
    await Promise.all(
      ["a@example.com", "b@example.com", "c@example.com", "d@example.com"].map(function send(to) {
        return mailer.sendTemplateEmail(to, "application_received", { name: "Pat", status: "pending" });
      })
    );
    var elapsed = Date.now() - started;

    assert.equal(mail.calls.length, 4);
    // Four sends need at least three gaps between them.
    assert.ok(elapsed >= 3 * 150 - 20, "took " + elapsed + " ms");
  });

  await db.closeDatabase();
});
