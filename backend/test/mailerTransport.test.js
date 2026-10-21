"use strict";

require("./helpers/testEnv");

var test = require("node:test");
var assert = require("node:assert/strict");
var nodemailer = require("nodemailer");

var mailer = require("../utils/mailer");

var SMTP_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_EHLO_NAME", "MAIL_FROM"];

/**
 * Replace the SMTP env vars for one subtest, restoring the originals after.
 * @param {object} t - The subtest's TestContext.
 * @param {object} values - SMTP_* / MAIL_FROM values to set; others are cleared.
 * @returns {void}
 */
function useSmtpEnv(t, values) {
  var saved = {};
  SMTP_KEYS.forEach(function (key) {
    saved[key] = process.env[key];
    delete process.env[key];
    if (values[key] !== undefined) {
      process.env[key] = values[key];
    }
  });
  t.after(function restore() {
    SMTP_KEYS.forEach(function (key) {
      delete process.env[key];
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      }
    });
  });
}

/**
 * Mock nodemailer.createTransport and record the options it was built with.
 * @param {object} t - The subtest's TestContext.
 * @returns {{options: Array<object>, sent: Array<object>}}
 */
function captureTransport(t) {
  var state = { options: [], sent: [] };
  t.mock.method(nodemailer, "createTransport", function fakeCreateTransport(options) {
    state.options.push(options);
    return {
      sendMail: function sendMail(mail) {
        state.sent.push(mail);
        return Promise.resolve({ messageId: "test" });
      },
    };
  });
  return state;
}

test("mailer transport: login is optional, EHLO name is configurable", async function mailerTransport(t) {
  await t.test("logs in when SMTP_USER is set", async function (t2) {
    useSmtpEnv(t2, {
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "team@example.com",
      SMTP_PASS: "secret",
      MAIL_FROM: "Team <team@example.com>",
    });
    var transport = captureTransport(t2);

    await mailer.sendPasswordReset("a@example.com", "https://app.example.com/reset?token=x");

    assert.equal(transport.options.length, 1);
    assert.deepEqual(transport.options[0].auth, { user: "team@example.com", pass: "secret" });
    assert.equal(transport.options[0].host, "smtp.example.com");
    assert.equal(transport.options[0].port, 587);
    assert.equal(transport.options[0].name, undefined);
  });

  await t.test("an IP-authorized relay: no login, sends as MAIL_FROM with the EHLO name", async function (t2) {
    useSmtpEnv(t2, {
      SMTP_HOST: "smtp-relay.example.com",
      SMTP_EHLO_NAME: "api.example.com",
      MAIL_FROM: "Team <team@example.com>",
    });
    var transport = captureTransport(t2);

    assert.equal(mailer.isMailConfigured(), true);
    await mailer.sendPasswordReset("a@example.com", "https://app.example.com/reset?token=x");

    assert.equal(transport.options.length, 1);
    assert.equal("auth" in transport.options[0], false);
    assert.equal(transport.options[0].name, "api.example.com");
    assert.equal(transport.sent[0].from, "Team <team@example.com>");
  });

  await t.test("needs a host and a sender address to count as configured", async function (t2) {
    useSmtpEnv(t2, { MAIL_FROM: "Team <team@example.com>" });
    assert.equal(mailer.isMailConfigured(), false, "no host");

    process.env.SMTP_HOST = "smtp-relay.example.com";
    delete process.env.MAIL_FROM;
    assert.equal(mailer.isMailConfigured(), false, "no sender");

    process.env.SMTP_USER = "team@example.com";
    assert.equal(mailer.isMailConfigured(), true, "SMTP_USER doubles as the sender");
  });
});
