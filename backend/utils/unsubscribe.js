"use strict";

var crypto = require("crypto");
var primaryClientOrigin = require("./clientOrigin").primaryClientOrigin;

/**
 * Unsubscribe links for announcement emails.
 *
 * The link has to work without logging in and from an old email, so it carries
 * a keyed hash of the user's id (HMAC with JWT_SECRET) instead of an expiring
 * token. Anyone holding it can do exactly one thing: turn that user's
 * announcement emails off. It can't be forged for other users.
 */

/**
 * @param {*} userId - The user's _id.
 * @returns {string} Hex HMAC of the id.
 */
function sign(userId) {
  var secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set. Copy .env.example to .env.");
  }
  return crypto.createHmac("sha256", secret).update("unsubscribe:" + String(userId)).digest("hex");
}

/**
 * Check an unsubscribe token in constant time.
 * @param {*} userId - The user id from the link.
 * @param {*} token - The token from the link.
 * @returns {boolean}
 */
function verify(userId, token) {
  var expected = Buffer.from(sign(userId));
  var given = Buffer.from(String(token || ""));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * The frontend page that confirms the unsubscribe (it POSTs to
 * /api/auth/unsubscribe, so a mail scanner opening the link can't unsubscribe
 * anyone by accident).
 * @param {*} userId - The user's _id.
 * @returns {string} Full URL.
 */
function link(userId) {
  return (
    primaryClientOrigin() +
    "/unsubscribe?u=" +
    encodeURIComponent(String(userId)) +
    "&t=" +
    sign(userId)
  );
}

module.exports = {
  sign: sign,
  verify: verify,
  link: link,
};
