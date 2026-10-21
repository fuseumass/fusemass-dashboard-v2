"use strict";

var crypto = require("crypto");
var primaryClientOrigin = require("./clientOrigin").primaryClientOrigin;

// How long an emailed password link works.
var RESET_TTL_MS = 60 * 60 * 1000; // "Forgot password": 1 hour
var SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // first password after acceptance: 7 days

/**
 * Give a user a fresh single-use password token and save it. Only its SHA-256
 * hash is stored (resetPasswordToken), so a database leak can't be used to set
 * passwords; the raw value goes into the emailed link. Issuing a new token
 * replaces any earlier one.
 *
 * @param {object} user - A User document.
 * @param {number} ttlMs - How long the link should work, in milliseconds.
 * @returns {Promise<string>} The raw token to put in the link.
 */
function issuePasswordToken(user, ttlMs) {
  var rawToken = crypto.randomBytes(32).toString("hex");
  user.resetPasswordToken = crypto.createHash("sha256").update(rawToken).digest("hex");
  user.resetPasswordExpires = new Date(Date.now() + ttlMs);

  return user.save().then(function afterSave() {
    return rawToken;
  });
}

/**
 * Frontend link that consumes a password token.
 *
 * @param {string} rawToken - Token from issuePasswordToken.
 * @param {object} [options]
 * @param {boolean} [options.setup] - Word the page as first-time setup.
 * @returns {string} The full URL.
 */
function passwordLink(rawToken, options) {
  var clientOrigin = primaryClientOrigin();
  var setup = options && options.setup ? "&setup=1" : "";
  return clientOrigin + "/reset-password?token=" + rawToken + setup;
}

/**
 * Whether a user has no way to sign in yet: no password and no linked Google
 * account. These accounts come from applying without an account (or imports);
 * login refuses them until a password is set through an emailed link.
 *
 * @param {object} user - A User document (or lean object).
 * @returns {boolean}
 */
function needsPasswordSetup(user) {
  return Boolean(user) && !user.passwordHash && !user.googleId;
}

module.exports = {
  RESET_TTL_MS: RESET_TTL_MS,
  SETUP_TTL_MS: SETUP_TTL_MS,
  issuePasswordToken: issuePasswordToken,
  passwordLink: passwordLink,
  needsPasswordSetup: needsPasswordSetup,
};
