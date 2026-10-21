"use strict";

var crypto = require("crypto");
var User = require("../schemas/user");
var signToken = require("../utils/signToken");
var mailer = require("../utils/mailer");
var passwordToken = require("../utils/passwordToken");
var primaryClientOrigin = require("../utils/clientOrigin").primaryClientOrigin;

/**
 * POST /api/auth/register
 * Create a new applicant account and return a signed JWT.
 *
 * Body: { name, email, password }
 * Everyone who registers this way is an "applicant"; admins are promoted later
 * by an existing admin via the admin routes.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function register(req, res) {
  var name = req.body.name;
  var email = req.body.email;
  var password = req.body.password;

  return User.findOne({ email: String(email).toLowerCase() })
    .then(function afterLookup(existing) {
      // Never let registering "claim" an existing account, including one made
      // by applying without an account: that would hand it to whoever typed
      // the email first. Its owner sets a password via an emailed link.
      if (existing && passwordToken.needsPasswordSetup(existing)) {
        res.status(409).json({
          error:
            "We already have an application from this email. Use \"Forgot password\" to set a password for it.",
        });
        return null;
      }
      if (existing) {
        res.status(409).json({ error: "An account with that email already exists." });
        return null;
      }

      return User.hashPassword(String(password)).then(function afterHash(hash) {
        return User.create({
          name: name,
          email: email,
          passwordHash: hash,
          role: "applicant",
        });
      });
    })
    .then(function afterCreate(user) {
      if (!user) {
        return; // conflict already handled above
      }

      var token = signToken({
        id: String(user._id),
        email: user.email,
        role: user.role,
      });

      res.status(201).json({ token: token, user: user.toJSON() });
    })
    .catch(function onError(err) {
      console.error("register failed:", err);
      res.status(500).json({ error: "Could not create account." });
    });
}

/**
 * POST /api/auth/login
 * Verify credentials and return a signed JWT.
 *
 * Body: { email, password }
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function login(req, res) {
  var email = req.body.email;
  var password = req.body.password;

  return User.findOne({ email: String(email).toLowerCase() })
    .then(function afterLookup(user) {
      if (!user) {
        res.status(401).json({ error: "Invalid email or password." });
        return null;
      }

      return user.verifyPassword(String(password)).then(function afterVerify(ok) {
        if (!ok) {
          res.status(401).json({ error: "Invalid email or password." });
          return;
        }

        var token = signToken({
          id: String(user._id),
          email: user.email,
          role: user.role,
        });

        res.status(200).json({ token: token, user: user.toJSON() });
      });
    })
    .catch(function onError(err) {
      console.error("login failed:", err);
      res.status(500).json({ error: "Could not log in." });
    });
}

/**
 * GET /api/auth/me
 * Return the currently authenticated user. Mounted behind `isAuthenticated`,
 * so `req.user` is guaranteed to be present here.
 *
 * @param {object} req - Express request (req.user set by parseToken).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function me(req, res) {
  var claims = req.user;

  if (!claims) {
    res.status(401).json({ error: "Authentication required." });
    return Promise.resolve();
  }

  return User.findById(claims.id)
    .then(function afterLookup(user) {
      if (!user) {
        res.status(404).json({ error: "User not found." });
        return;
      }
      res.status(200).json({ user: user.toJSON() });
    })
    .catch(function onError(err) {
      console.error("me failed:", err);
      res.status(500).json({ error: "Could not load profile." });
    });
}

/**
 * Issue a signed JWT for a user document. Shared by the register/login flows and
 * the Google OAuth callback.
 * @param {object} user - A User document.
 * @returns {string} Signed JWT.
 */
function issueToken(user) {
  return signToken({
    id: String(user._id),
    email: user.email,
    role: user.role,
  });
}

/**
 * GET /api/auth/google/callback (after passport)
 * passport has attached the authenticated user to `req.user`. We sign our own
 * JWT and hand control back to the frontend by redirecting to its callback page
 * with the token in the query string.
 *
 * @param {object} req - Express request (req.user is the User document here).
 * @param {object} res - Express response.
 * @returns {void}
 */
function googleCallback(req, res) {
  var clientOrigin = primaryClientOrigin();

  if (!req.user) {
    res.redirect(clientOrigin + "/login?error=google");
    return;
  }

  var token = issueToken(req.user);
  res.redirect(clientOrigin + "/auth/callback?token=" + encodeURIComponent(token));
}

/**
 * POST /api/auth/forgot-password
 * Generate a one-hour reset token, store its hash, and email the plaintext link.
 * Always responds 200 so the endpoint can't be used to probe which emails exist.
 *
 * Body: { email }
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function forgotPassword(req, res) {
  var email = req.body.email;

  return User.findOne({ email: String(email).toLowerCase() })
    .then(function afterLookup(user) {
      if (!user) {
        return null; // don't reveal non-existence
      }

      // Also how someone who applied without an account sets their first
      // password: the link only reaches the inbox that owns the address.
      return passwordToken.issuePasswordToken(user, passwordToken.RESET_TTL_MS).then(function afterIssue(rawToken) {
        return mailer.sendPasswordReset(user.email, passwordToken.passwordLink(rawToken));
      });
    })
    .then(function afterSend() {
      res.status(200).json({
        message: "If an account exists for that email, a reset link has been sent.",
      });
    })
    .catch(function onError(err) {
      console.error("forgotPassword failed:", err);
      res.status(500).json({ error: "Could not process request." });
    });
}

/**
 * POST /api/auth/reset-password
 * Consume a reset token and set a new password.
 *
 * Body: { token, password }
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function resetPassword(req, res) {
  var token = req.body.token;
  var password = req.body.password;

  var hashed = crypto.createHash("sha256").update(String(token)).digest("hex");

  return User.findOne({
    resetPasswordToken: hashed,
    resetPasswordExpires: { $gt: new Date() },
  })
    .then(function afterLookup(user) {
      if (!user) {
        res.status(400).json({ error: "Reset link is invalid or has expired." });
        return null;
      }

      return User.hashPassword(String(password)).then(function afterHash(hash) {
        user.passwordHash = hash;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        return user.save().then(function afterSave() {
          res.status(200).json({ token: issueToken(user), user: user.toJSON() });
        });
      });
    })
    .catch(function onError(err) {
      console.error("resetPassword failed:", err);
      res.status(500).json({ error: "Could not reset password." });
    });
}

/**
 * POST /api/auth/setup-admin
 * One-time bootstrap of the first admin. Only works when the SETUP_ADMIN env var
 * is "true" AND no admin exists yet — so it can't be used to escalate once the
 * org is set up. Promotes the user with the given email to admin.
 *
 * Body: { email }
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function setupAdmin(req, res) {
  if (String(process.env.SETUP_ADMIN) !== "true") {
    res.status(403).json({ error: "Admin setup is disabled." });
    return Promise.resolve();
  }

  var email = req.body.email;

  return User.findOne({ role: "admin" })
    .then(function afterCheck(existingAdmin) {
      if (existingAdmin) {
        res.status(409).json({ error: "An admin already exists. Setup is closed." });
        return null;
      }
      return User.findOneAndUpdate(
        { email: String(email).toLowerCase() },
        { $set: { role: "admin" } },
        { new: true }
      );
    })
    .then(function afterPromote(user) {
      if (user === null) {
        return; // conflict handled above
      }
      if (!user) {
        res.status(404).json({ error: "No user with that email. Register first, then run setup." });
        return;
      }
      res.status(200).json({ user: user.toJSON() });
    })
    .catch(function onError(err) {
      console.error("setupAdmin failed:", err);
      res.status(500).json({ error: "Could not complete admin setup." });
    });
}

module.exports = {
  register: register,
  login: login,
  me: me,
  googleCallback: googleCallback,
  forgotPassword: forgotPassword,
  resetPassword: resetPassword,
  setupAdmin: setupAdmin,
};
