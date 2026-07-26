"use strict";

/**
 * Route guard: allow the request through only when the caller is a logged-in
 * admin. Mount it after (or in place of) `isAuthenticated` on admin-only routes.
 *
 *   router.get("/applications", isAdmin, listApplications);
 *
 * @param {object} req - Express request (expects req.user from parseToken).
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {void}
 */
function isAdmin(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return;
  }

  return next();
}

module.exports = isAdmin;
