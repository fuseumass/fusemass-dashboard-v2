"use strict";

/**
 * Poll `check` until it returns truthy, or throw after `timeoutMs`. Used to
 * assert on fire-and-forget side effects (e.g. an email send kicked off
 * after the HTTP response is already written) without a fixed sleep.
 * @param {function(): boolean} check - Returns true once the condition holds.
 * @param {object} [options]
 * @param {number} [options.timeoutMs=1000]
 * @param {number} [options.intervalMs=10]
 * @returns {Promise<void>}
 */
function waitFor(check, options) {
  var timeoutMs = (options && options.timeoutMs) || 1000;
  var intervalMs = (options && options.intervalMs) || 10;
  var start = Date.now();

  return new Promise(function executor(resolve, reject) {
    function attempt() {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error("waitFor: condition not met within " + timeoutMs + "ms"));
        return;
      }
      setTimeout(attempt, intervalMs);
    }
    attempt();
  });
}

module.exports = waitFor;
