"use strict";

var outbox = require("./outbox");
var autoAccept = require("./autoAccept");

// The timers that act without a request: the email outbox (sends and retries
// emails) and domain auto-accept (accepts applications). server.js starts them
// once it is listening. DISABLE_BACKGROUND_WORKERS=true (or 1) keeps both off,
// so a local copy can point at a real database without emailing anyone or
// changing applications.

/**
 * Whether DISABLE_BACKGROUND_WORKERS asks for the workers to stay off.
 * @param {object} env - Environment (process.env).
 * @returns {boolean}
 */
function disabled(env) {
  var value = String((env && env.DISABLE_BACKGROUND_WORKERS) || "").trim().toLowerCase();
  return value === "true" || value === "1";
}

/**
 * Start the outbox and auto-accept workers, unless disabled.
 * @param {object} env - Environment (process.env).
 * @returns {boolean} Whether the workers were started.
 */
function start(env) {
  if (disabled(env)) {
    console.log("Background workers disabled.");
    return false;
  }
  outbox.startWorker();
  autoAccept.startWorker();
  return true;
}

module.exports = {
  disabled: disabled,
  start: start,
};
