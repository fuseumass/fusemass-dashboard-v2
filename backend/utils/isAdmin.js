"use strict";

var requireRole = require("./currentRole").requireRole;

/**
 * Route guard: allow the request through only when the caller is a logged-in
 * admin. Mount it after (or in place of) `isAuthenticated` on admin-only routes.
 *
 *   router.get("/users", isAdmin, searchUsers);
 *
 * The role is checked against the database, not the JWT, so a demotion
 * takes effect immediately (see utils/currentRole).
 *
 * @param {object} req - Express request (expects req.user from parseToken).
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {Promise<void>|void}
 */
var isAdmin = requireRole(["admin"], "Admin access required.");

module.exports = isAdmin;
