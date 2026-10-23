"use strict";

var User = require("../schemas/user");
var emailVerification = require("./emailVerification");

/**
 * Route guard: allow the request through only when the logged-in user's email
 * address is verified. Mount it after `isAuthenticated` on routes that need a
 * confirmed inbox (applying, because the acceptance QR code is emailed).
 *
 * The flag is read from the database, not the JWT: a user who verifies
 * their email can apply straight away, without logging in again. Accounts
 * with no flag at all (created before email verification existed) count as
 * verified, and nothing is enforced while outgoing email isn't configured
 * (see utils/emailVerification.isEnforced).
 *
 * Responds 403 with `code: "EMAIL_NOT_VERIFIED"` so the frontend can show a
 * "check your inbox" prompt rather than a generic error.
 *
 * @param {object} req - Express request (expects req.user from parseToken).
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {Promise<void>|void}
 */
function isEmailVerified(req, res, next) {
  if (!req.user || !req.user.id) {
    res.status(401).json({ error: "Authentication required." });
    return undefined;
  }

  if (!emailVerification.isEnforced()) {
    return next();
  }

  return User.findById(req.user.id)
    .select("emailVerified")
    .lean()
    .then(function afterFind(user) {
      if (!user) {
        res.status(401).json({ error: "Authentication required." });
        return;
      }
      // `=== false`, not falsy: lean() skips schema defaults, so a user with no
      // stored flag reads as undefined and must stay allowed.
      if (user.emailVerified === false) {
        res.status(403).json({
          error: "Please verify your email address before applying. Check your inbox for the verification link.",
          code: "EMAIL_NOT_VERIFIED",
        });
        return;
      }
      next();
    })
    .catch(next);
}

module.exports = isEmailVerified;
