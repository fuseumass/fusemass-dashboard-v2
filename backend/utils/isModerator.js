"use strict";

/**
 * Route guard: allow logged-in moderators OR admins through. Mount it on routes
 * that reviewers need (application review, and later hardware/judging views).
 * Admin-only routes (org setup) use `isAdmin` instead.
 *
 *   router.get("/applications", isModerator, adminController.listApplications);
 *
 * @param {object} req - Express request (expects req.user from parseToken).
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {void}
 */
function isModerator(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  if (req.user.role !== "moderator" && req.user.role !== "admin") {
    res.status(403).json({ error: "Moderator or admin access required." });
    return;
  }

  return next();
}

module.exports = isModerator;
