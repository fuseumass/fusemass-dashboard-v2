"use strict";

var rateLimit = require("express-rate-limit");

// Shared defaults. Env-overridable so tests can tighten the budget without
// waiting out a real window, and so the window can be tuned per deployment.
var WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
var DEFAULT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX) || 20;

/**
 * Read a per-route max from the environment, falling back to the shared
 * default. Lets one endpoint be loosened on event day (hundreds of attendees
 * behind one venue NAT all look like a single IP) without touching the others.
 *
 * @param {string} name - Env var suffix, e.g. "LOGIN".
 * @returns {number} The max requests allowed per window.
 */
function maxFor(name) {
  return Number(process.env["AUTH_RATE_LIMIT_MAX_" + name]) || DEFAULT_MAX;
}

/**
 * Build a rate limiter with this project's shared settings. Each call creates
 * its own store, so limiters built here do NOT share a budget.
 *
 * @param {object} options - { max, skipSuccessfulRequests }.
 * @returns {function} Express middleware.
 */
function makeAuthLimiter(options) {
  var settings = options || {};

  return rateLimit({
    windowMs: WINDOW_MS,
    max: settings.max,
    skipSuccessfulRequests: Boolean(settings.skipSuccessfulRequests),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please try again later." },
  });
}

// One limiter per endpoint rather than one shared across all four. A single
// budget meant a burst of signups could lock out password resets (and vice
// versa) even though they are unrelated kinds of abuse.
module.exports = {
  // Successful logins are not counted: the budget exists to slow credential
  // guessing, and legitimate attendees sharing one NAT'd venue IP would
  // otherwise exhaust it just by logging in normally.
  login: makeAuthLimiter({ max: maxFor("LOGIN"), skipSuccessfulRequests: true }),
  register: makeAuthLimiter({ max: maxFor("REGISTER") }),
  forgotPassword: makeAuthLimiter({ max: maxFor("FORGOT_PASSWORD") }),
  setupAdmin: makeAuthLimiter({ max: maxFor("SETUP_ADMIN") }),
  // Applying without an account (no login to slow down spam submissions).
  publicApply: makeAuthLimiter({ max: maxFor("PUBLIC_APPLY") }),
  // Team invites send an email each, so they're capped like the other
  // email-sending endpoints.
  teamInvite: makeAuthLimiter({ max: maxFor("TEAM_INVITE") }),
};
