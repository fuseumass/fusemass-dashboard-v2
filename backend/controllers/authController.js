"use strict";

var User = require("../schemas/user");
var signToken = require("../utils/signToken");

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
  var name = req.body && req.body.name;
  var email = req.body && req.body.email;
  var password = req.body && req.body.password;

  if (!name || !email || !password) {
    res.status(400).json({ error: "name, email and password are required." });
    return Promise.resolve();
  }

  return User.findOne({ email: String(email).toLowerCase() })
    .then(function afterLookup(existing) {
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
  var email = req.body && req.body.email;
  var password = req.body && req.body.password;

  if (!email || !password) {
    res.status(400).json({ error: "email and password are required." });
    return Promise.resolve();
  }

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

module.exports = {
  register: register,
  login: login,
  me: me,
};
