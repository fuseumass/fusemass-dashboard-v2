"use strict";

var jwt = require("jsonwebtoken");

/**
 * The claims we embed in every JWT. Keep this small — it is sent on every
 * request and is readable by anyone who holds the token.
 *
 * @typedef {Object} TokenPayload
 * @property {string} id    - The user's Mongo _id as a string.
 * @property {string} email - The user's email.
 * @property {"applicant" | "admin"} role - The user's role.
 */

/**
 * Sign a JWT for a given user. Used by the auth controller after a successful
 * register or login.
 *
 * @param {TokenPayload} payload - Claims to embed in the token.
 * @returns {string} A signed JWT string.
 */
function signToken(payload) {
  var secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set. Copy .env.example to .env.");
  }

  var expiresIn = process.env.JWT_EXPIRES_IN || "7d";

  return jwt.sign(payload, secret, { expiresIn: expiresIn });
}

module.exports = signToken;
