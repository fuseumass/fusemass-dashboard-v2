"use strict";

var User = require("../schemas/user");

/**
 * Look up the caller's role as it is now, rather than trusting the role
 * baked into their JWT when they logged in (tokens last JWT_EXPIRES_IN, 7
 * days by default). Promoting someone to moderator therefore works without
 * them logging in again, and demoting someone takes effect on their very
 * next request. Also refreshes req.user.role for downstream handlers.
 *
 * @param {object} req - Express request (req.user from parseToken).
 * @returns {Promise<string|null>} The role, or null when the account is gone.
 */
function currentRole(req) {
  return User.findById(req.user.id)
    .select("role")
    .lean()
    .then(function afterFind(user) {
      if (!user) {
        return null;
      }
      req.user.role = user.role;
      return user.role;
    });
}

/**
 * Build a guard that lets through only callers whose current role is in
 * `roles`. Used by isModerator and isAdmin.
 *
 * @param {Array<string>} roles - Allowed roles.
 * @param {string} deniedMessage - 403 error message.
 * @returns {function} Express middleware (req, res, next).
 */
function requireRole(roles, deniedMessage) {
  return function roleGuard(req, res, next) {
    if (!req.user || !req.user.id) {
      res.status(401).json({ error: "Authentication required." });
      return undefined;
    }
    return currentRole(req)
      .then(function afterRole(role) {
        if (role === null) {
          res.status(401).json({ error: "Authentication required." });
          return;
        }
        if (roles.indexOf(role) === -1) {
          res.status(403).json({ error: deniedMessage });
          return;
        }
        next();
      })
      .catch(next);
  };
}

module.exports = {
  currentRole: currentRole,
  requireRole: requireRole,
};
