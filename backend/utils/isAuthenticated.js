"use strict";

/**
 * Route guard: allow the request through only when `parseToken` attached a valid
 * user. Mount it on any route that requires the caller to be logged in.
 *
 *   router.get("/me", isAuthenticated, getMe);
 *
 * @param {object} req - Express request (expects req.user from parseToken).
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {void}
 */
function isAuthenticated(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  return next();
}

module.exports = isAuthenticated;
