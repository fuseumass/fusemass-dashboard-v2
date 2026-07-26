"use strict";

var jwt = require("jsonwebtoken");

/**
 * Pull the raw JWT string off an incoming request. We accept it in two places:
 *   1. `Authorization: Bearer <token>` header (used by the Next.js frontend), or
 *   2. a `token` cookie (handy for server-rendered requests).
 *
 * @param {object} req - Express request.
 * @returns {string|null} The raw token, or null when none is present.
 */
function extractToken(req) {
  var header = req.headers.authorization;
  if (header && header.indexOf("Bearer ") === 0) {
    return header.slice("Bearer ".length).trim();
  }

  // `req.cookies` is populated by cookie-parser, mounted before this middleware.
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }

  return null;
}

/**
 * Global middleware, mounted once at the top of server.js. It looks for a JWT on
 * every incoming request, hands it to `jwt.verify` to decode, and makes the
 * result available on `req.user` (shape: { id, email, role }), or null when
 * there is no valid token. It never rejects the request itself: routes that
 * require a login use `isAuthenticated`; routes that require admin use `isAdmin`.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {void}
 */
function parseToken(req, res, next) {
  req.user = null;

  var token = extractToken(req);
  if (!token) {
    return next();
  }

  var secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set. Copy .env.example to .env.");
  }

  try {
    req.user = jwt.verify(token, secret);
  } catch (err) {
    // Expired or tampered token — treat the request as anonymous rather than
    // erroring, so public routes still work.
    req.user = null;
  }

  return next();
}

module.exports = parseToken;
