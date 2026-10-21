"use strict";

var crypto = require("crypto");
var mailer = require("./mailer");
var primaryClientOrigin = require("./clientOrigin").primaryClientOrigin;

// How long an emailed verification link works.
var VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Minimum gap between two verification emails for the same account, on top of
// the per-IP rate limit, so one account cannot be used to flood an inbox.
var RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute

/**
 * SHA-256 hex digest of a raw token. Only this is stored, so a database leak
 * cannot be used to verify addresses; the raw value goes into the emailed link.
 *
 * @param {string} rawToken - Token from the emailed link.
 * @returns {string} The hash that is stored in `emailVerificationToken`.
 */
function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

/**
 * Create a fresh verification token. Returns the raw value (for the link) and
 * the User fields to store (only the hash, plus expiry and send time).
 *
 * @returns {{rawToken: string, fields: object}}
 */
function generateToken() {
  var rawToken = crypto.randomBytes(32).toString("hex");
  var now = Date.now();

  return {
    rawToken: rawToken,
    fields: {
      emailVerificationToken: hashToken(rawToken),
      emailVerificationExpires: new Date(now + VERIFY_TTL_MS),
      emailVerificationSentAt: new Date(now),
    },
  };
}

/**
 * Whether new accounts have to verify their email. Verification needs a way to
 * deliver the link, so it applies only while outgoing email is configured;
 * otherwise (local development, a deployment that has not set up SMTP yet)
 * nobody could ever finish it and applications would be locked for everyone.
 *
 * @returns {boolean}
 */
function isEnforced() {
  return mailer.isMailConfigured();
}

/**
 * Frontend link that consumes a verification token.
 *
 * @param {string} rawToken - Token from generateToken.
 * @returns {string} The full URL.
 */
function verificationLink(rawToken) {
  return primaryClientOrigin() + "/verify-email?token=" + rawToken;
}

/**
 * Email the verification link using the `verify_email` template. When SMTP is
 * not configured the link is printed to the server log instead (like the
 * password-reset link), so a developer can still follow it.
 *
 * @param {object} user - A User document (or anything with `name` and `email`).
 * @param {string} rawToken - Token from generateToken.
 * @returns {Promise<void>}
 */
function sendVerificationEmail(user, rawToken) {
  var link = verificationLink(rawToken);

  if (!mailer.isMailConfigured()) {
    console.warn("SMTP not configured; email verification link:", link);
    return Promise.resolve();
  }

  return mailer.sendTemplateEmail(user.email, "verify_email", {
    name: user.name,
    verifyUrl: link,
  });
}

/**
 * Mark a user's email as verified and drop any pending verification token.
 * Mutates the document; the caller saves it.
 *
 * @param {object} user - A User document.
 * @returns {void}
 */
function markVerified(user) {
  user.emailVerified = true;
  user.emailVerifiedAt = new Date();
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  user.emailVerificationSentAt = undefined;
}

module.exports = {
  VERIFY_TTL_MS: VERIFY_TTL_MS,
  RESEND_COOLDOWN_MS: RESEND_COOLDOWN_MS,
  hashToken: hashToken,
  generateToken: generateToken,
  isEnforced: isEnforced,
  verificationLink: verificationLink,
  sendVerificationEmail: sendVerificationEmail,
  markVerified: markVerified,
};
