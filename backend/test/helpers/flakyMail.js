"use strict";

var nodemailer = require("nodemailer");

/**
 * Like mailMock.mockTransport, but sends can be made to fail: queue errors
 * with `failNext` and the next sendMail calls reject with them (in order)
 * before sends succeed again. Scoped to the given TestContext.
 *
 * @param {object} t - The node:test TestContext (the subtest's own `t`).
 * @returns {{calls: Array<object>, attempts: number, failNext: function(number, Error): void}}
 *   `calls` holds only the sends that succeeded; `attempts` counts every sendMail call.
 */
function mockFlakyTransport(t) {
  var state = { calls: [], attempts: 0, failures: [] };

  state.failNext = function failNext(count, error) {
    for (var i = 0; i < count; i += 1) {
      state.failures.push(error);
    }
  };

  t.mock.method(nodemailer, "createTransport", function fakeCreateTransport() {
    return {
      sendMail: function sendMail(options) {
        state.attempts += 1;
        var failure = state.failures.shift();
        if (failure) {
          return Promise.reject(failure);
        }
        state.calls.push(options);
        return Promise.resolve({ messageId: "test-" + state.calls.length });
      },
    };
  });

  return state;
}

/**
 * An error shaped like nodemailer's SMTP errors.
 * @param {string} message - Server text.
 * @param {number} responseCode - SMTP reply code.
 * @returns {Error}
 */
function smtpError(message, responseCode) {
  var err = new Error(message);
  err.responseCode = responseCode;
  err.response = responseCode + " " + message;
  return err;
}

module.exports = { mockFlakyTransport: mockFlakyTransport, smtpError: smtpError };
