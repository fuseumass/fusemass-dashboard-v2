"use strict";

var crypto = require("crypto");
var validator = require("validator");
var User = require("../schemas/user");
var signToken = require("../utils/signToken");
var mailer = require("../utils/mailer");
var passwordToken = require("../utils/passwordToken");
var emailVerification = require("../utils/emailVerification");
var primaryClientOrigin = require("../utils/clientOrigin").primaryClientOrigin;

/**
 * POST /api/auth/register
 * Create a new applicant account and return a signed JWT.
 *
 * Body: { name, email, password }
 * Everyone who registers this way is an "applicant"; admins are promoted later
 * by an existing admin via the admin routes.
 *
 * The email must be a real address (400 otherwise). When outgoing email is
 * configured the account starts unverified and a verification link is emailed
 * (24 hours, single use); the caller can log in straight away but cannot apply
 * until the address is verified. Without email configured nothing could be
 * delivered, so the account starts verified (see utils/emailVerification).
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function register(req, res) {
  var name = req.body.name;
  var email = req.body.email;
  var password = req.body.password;

  if (!validator.isEmail(String(email))) {
    res.status(400).json({ error: "A valid email address is required." });
    return Promise.resolve();
  }

  // Generated up front so it is written in the same insert as the account.
  var verification = emailVerification.isEnforced() ? emailVerification.generateToken() : null;

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
        var fields = {
          name: name,
          email: email,
          passwordHash: hash,
          role: "applicant",
        };
        if (verification) {
          fields.emailVerified = false;
          Object.assign(fields, verification.fields);
        }
        return User.create(fields);
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

      if (verification) {
        // After the response: a slow or failing mail server must not make
        // sign-up look broken. The user can ask for another link.
        emailVerification.sendVerificationEmail(user, verification.rawToken).catch(function onMailError(err) {
          console.error("Failed to send verification email:", err);
        });
      }
    })
    .catch(function onError(err) {
      if (res.headersSent) {
        console.error("register failed after responding:", err);
        return;
      }
      // Two sign-ups for the same email at once: the loser trips the unique index.
      if (err && err.code === 11000) {
        res.status(409).json({ error: "An account with that email already exists." });
        return;
      }
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
        // The link only reached the inbox that owns this address, so using it
        // also proves ownership (this is how someone who applied without an
        // account becomes a verified user).
        if (user.emailVerified === false) {
          emailVerification.markVerified(user);
        }
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
 * POST /api/auth/verify-email
 * Consume an emailed verification token and mark the address verified. Public
 * (the link may be opened on another device) and single use: the token is
 * cleared in the same atomic update that verifies the account.
 *
 * Body: { token }
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function verifyEmail(req, res) {
  var hashed = emailVerification.hashToken(req.body.token);
  var now = new Date();

  return User.findOneAndUpdate(
    { emailVerificationToken: hashed, emailVerificationExpires: { $gt: now } },
    {
      $set: { emailVerified: true, emailVerifiedAt: now },
      $unset: { emailVerificationToken: "", emailVerificationExpires: "", emailVerificationSentAt: "" },
    },
    { new: true }
  )
    .then(function afterVerify(user) {
      if (!user) {
        res.status(400).json({
          error: "This verification link is invalid or has expired. Log in to request a new one.",
        });
        return;
      }
      res.status(200).json({ message: "Your email address has been verified.", email: user.email });
    })
    .catch(function onError(err) {
      console.error("verifyEmail failed:", err);
      res.status(500).json({ error: "Could not verify email." });
    });
}

/**
 * POST /api/auth/resend-verification
 * Email a new verification link to the logged-in user, replacing any earlier
 * one. Rate-limited per IP in the route, and per account here (one email a
 * minute) so a single account cannot be used to flood an inbox. Does nothing
 * for an already-verified account.
 *
 * @param {object} req - Express request (req.user set by parseToken).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function resendVerification(req, res) {
  var claims = req.user;
  if (!claims) {
    res.status(401).json({ error: "Authentication required." });
    return Promise.resolve();
  }

  return User.findById(claims.id)
    .then(function afterLookup(user) {
      if (!user) {
        res.status(401).json({ error: "Authentication required." });
        return null;
      }
      if (user.emailVerified !== false) {
        res.status(200).json({ message: "Your email address is already verified.", emailVerified: true });
        return null;
      }

      var verification = emailVerification.generateToken();
      var cutoff = new Date(Date.now() - emailVerification.RESEND_COOLDOWN_MS);

      // One atomic update both enforces the cooldown and stores the new token,
      // so two quick requests cannot both get through.
      return User.findOneAndUpdate(
        {
          _id: user._id,
          emailVerified: false,
          $or: [{ emailVerificationSentAt: { $exists: false } }, { emailVerificationSentAt: { $lte: cutoff } }],
        },
        { $set: verification.fields },
        { new: true }
      ).then(function afterUpdate(updated) {
        if (!updated) {
          res.status(429).json({
            error: "We just sent a verification email. Please wait a minute before requesting another.",
          });
          return;
        }
        return emailVerification.sendVerificationEmail(updated, verification.rawToken).then(function afterSend() {
          res.status(200).json({ message: "Verification email sent. Check your inbox.", emailVerified: false });
        });
      });
    })
    .catch(function onError(err) {
      console.error("resendVerification failed:", err);
      res.status(500).json({ error: "Could not send verification email." });
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
  verifyEmail: verifyEmail,
  resendVerification: resendVerification,
  setupAdmin: setupAdmin,
};
