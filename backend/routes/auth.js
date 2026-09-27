"use strict";

var express = require("express");
var authController = require("../controllers/authController");
var isAuthenticated = require("../utils/isAuthenticated");
var passportUtil = require("../utils/passport");
var googleStatus = require("../utils/googleStatus");
var validateBody = require("../utils/validateBody");
var authRateLimit = require("../utils/authRateLimit");

var passport = passportUtil.passport;
var router = express.Router();

// Public: email/password. Rate-limited (ahead of validation, so abusive
// traffic doesn't even reach body parsing) to slow brute force.
router.post(
  "/register",
  authRateLimit,
  validateBody({
    name: { required: true, type: "string" },
    email: { required: true, type: "string" },
    password: { required: true, type: "string" },
  }),
  authController.register
);
router.post(
  "/login",
  authRateLimit,
  validateBody({
    email: { required: true, type: "string" },
    password: { required: true, type: "string" },
  }),
  authController.login
);

// Public: password reset (nodemailer).
router.post(
  "/forgot-password",
  authRateLimit,
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

// One-time first-admin bootstrap, gated by the SETUP_ADMIN env var.
router.post(
  "/setup-admin",
  authRateLimit,
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
    var clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:3000";
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

// Requires a valid token.
router.get("/me", isAuthenticated, authController.me);

module.exports = router;
