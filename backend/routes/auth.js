"use strict";

var express = require("express");
var authController = require("../controllers/authController");
var isAuthenticated = require("../utils/isAuthenticated");
var passportUtil = require("../utils/passport");
var googleStatus = require("../utils/googleStatus");
var validateBody = require("../utils/validateBody");
var authRateLimit = require("../utils/authRateLimit");
var primaryClientOrigin = require("../utils/clientOrigin").primaryClientOrigin;

var passport = passportUtil.passport;
var router = express.Router();

// Public: email/password. Rate-limited (ahead of validation, so abusive
// traffic doesn't even reach body parsing) to slow brute force. Each endpoint
// has its own budget, so a burst on one cannot lock out the others.
router.post(
  "/register",
  authRateLimit.register,
  validateBody({
    name: { required: true, type: "string" },
    email: { required: true, type: "string" },
    password: { required: true, type: "string" },
  }),
  authController.register
);
router.post(
  "/login",
  authRateLimit.login,
  validateBody({
    email: { required: true, type: "string" },
    password: { required: true, type: "string" },
  }),
  authController.login
);

// Public: password reset (nodemailer).
router.post(
  "/forgot-password",
  authRateLimit.forgotPassword,
  validateBody({ email: { required: true, type: "string" } }),
  authController.forgotPassword
);
router.post(
  "/reset-password",
  validateBody({
    token: { required: true, type: "string" },
    password: { required: true, type: "string" },
  }),
  authController.resetPassword
);

// Public: confirm an email address from the emailed link. The token is 256
// random bits, so no limiter is needed against guessing.
router.post(
  "/verify-email",
  validateBody({ token: { required: true, type: "string" } }),
  authController.verifyEmail
);
// Logged in: email a new verification link (limited per IP and per account).
router.post(
  "/resend-verification",
  authRateLimit.resendVerification,
  isAuthenticated,
  authController.resendVerification
);

// One-time first-admin bootstrap, gated by the SETUP_ADMIN env var.
router.post(
  "/setup-admin",
  authRateLimit.setupAdmin,
  validateBody({ email: { required: true, type: "string" } }),
  authController.setupAdmin
);

// Public: Google OAuth. Availability depends on env credentials, the env flag,
// AND the admin org setting — all checked via googleStatus.isGoogleEnabled().
router.get("/google", function startGoogle(req, res, next) {
  googleStatus
    .isGoogleEnabled()
    .then(function afterCheck(enabled) {
      if (!enabled) {
        res.status(501).json({ error: "Google sign-in is not available." });
        return;
      }
      passport.authenticate("google", { scope: ["profile", "email"], session: false })(
        req,
        res,
        next
      );
    })
    .catch(next);
});

router.get(
  "/google/callback",
  function handleGoogle(req, res, next) {
    var clientOrigin = primaryClientOrigin();
    googleStatus
      .isGoogleEnabled()
      .then(function afterCheck(enabled) {
        if (!enabled) {
          res.redirect(clientOrigin + "/login?error=google");
          return;
        }
        passport.authenticate("google", {
          session: false,
          failureRedirect: clientOrigin + "/login?error=google",
        })(req, res, next);
      })
      .catch(next);
  },
  authController.googleCallback
);

// Public: the unsubscribe link in announcement emails (the token in the body
// is the proof, so no login). Idempotent.
router.post(
  "/unsubscribe",
  authRateLimit.unsubscribe,
  validateBody({
    u: { required: true, type: "string" },
    t: { required: true, type: "string" },
  }),
  authController.unsubscribe
);

router.post("/judge/accept", require("../controllers/judgeController").accept);

// Requires a valid token.
router.get("/me", isAuthenticated, authController.me);
// Own preferences: whether to get announcement emails.
router.patch(
  "/me",
  isAuthenticated,
  validateBody({ marketingEmailConsent: { required: true, type: "boolean" } }),
  authController.updateMe
);

module.exports = router;
