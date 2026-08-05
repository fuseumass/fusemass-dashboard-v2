"use strict";

var nodemailer = require("nodemailer");

/**
 * Replace nodemailer.createTransport with a fake transport that records every
 * sendMail call instead of hitting a real SMTP server. Scoped to the given
 * TestContext, so node:test restores the real nodemailer.createTransport
 * automatically when that test/subtest finishes.
 *
 * @param {object} t - The node:test TestContext (subtest's `t`, not the file's).
 * @returns {{calls: Array<{from: string, to: string, subject: string, text: string, html: string}>}}
 */
function mockTransport(t) {
  var state = { calls: [] };

  t.mock.method(nodemailer, "createTransport", function fakeCreateTransport() {
    return {
      sendMail: function sendMail(options) {
        state.calls.push(options);
        return Promise.resolve({ messageId: "test-" + state.calls.length });
      },
    };
  });

  return state;
}

module.exports = { mockTransport: mockTransport };
