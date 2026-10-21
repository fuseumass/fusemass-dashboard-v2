"use strict";

var requireRole = require("./currentRole").requireRole;

/**
 * Route guard: allow logged-in moderators OR admins through. Mount it on routes
 * that reviewers need (application review, check-in, meals). Admin-only
 * routes (org setup, roles) use `isAdmin` instead.
 *
 *   router.get("/applications", isModerator, adminController.listApplications);
 *
 * The role is checked against the database, not the JWT, so someone promoted
 * to moderator doesn't have to log in again (see utils/currentRole).
 *
 * @param {object} req - Express request (expects req.user from parseToken).
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {Promise<void>|void}
 */
var isModerator = requireRole(["moderator", "admin"], "Moderator or admin access required.");

module.exports = isModerator;
