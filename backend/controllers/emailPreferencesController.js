"use strict";

var mongoose = require("mongoose");
var Application = require("../schemas/application");
var activeApplications = require("../utils/activeApplications");
var User = require("../schemas/user");
var emailCategories = require("../utils/emailCategories");
var unsubscribe = require("../utils/unsubscribe");

/**
 * The preferences answer shared by every endpoint here.
 * @param {object} user - User document or lean object.
 * @returns {{preferences: object, categories: Array<object>}}
 */
function describe(user, accepted) {
  return {
    preferences: emailCategories.preferencesOf(user, { accepted: accepted }),
    updatedAt: user.emailPreferencesUpdatedAt || null,
    categories: emailCategories.list(),
  };
}

/**
 * describe() for a user, looking up whether they have an accepted
 * application (it decides announcements for people who never chose).
 * @param {object} user - Lean user.
 * @returns {Promise<object>}
 */
function describeFor(user) {
  if (emailCategories.announcementChoice(user) !== null) {
    return Promise.resolve(describe(user, false));
  }
  return Application.exists(activeApplications.active({ applicant: user._id, status: "accepted" })).then(function found(hit) {
    return describe(user, Boolean(hit));
  });
}

/**
 * "a***@example.com": enough for someone to recognise their own address on
 * the public page, not enough to learn someone else's from a forwarded link.
 * @param {string} email - Address.
 * @returns {string}
 */
function maskEmail(email) {
  var text = String(email || "");
  var at = text.indexOf("@");
  if (at < 1) {
    return "";
  }
  return text.charAt(0) + "***" + text.slice(at);
}

/**
 * Apply a preferences change to one user.
 * @param {*} userId - User _id.
 * @param {object} input - `{ category: boolean }`.
 * @returns {Promise<{errors: (Array<string>|undefined), user: (object|null)}>}
 */
function applyChange(userId, input) {
  var update = emailCategories.toUpdate(input);
  if (update.errors.length) {
    return Promise.resolve({ errors: update.errors, user: null });
  }
  return User.findByIdAndUpdate(userId, { $set: update.set }, { new: true })
    .select("_id email marketingEmailConsent emailPreferences emailPreferencesUpdatedAt")
    .lean()
    .then(function afterUpdate(user) {
      return { user: user };
    });
}

/**
 * Read a token from the body or query, or answer 400.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {{userId: string, category: string}|null}
 */
function tokenFrom(req, res) {
  var raw = (req.body && req.body.token) || (req.query && req.query.token) || "";
  var data = unsubscribe.readToken(raw);
  if (!data || !mongoose.isValidObjectId(data.userId) || emailCategories.ALL.indexOf(data.category) === -1) {
    res.status(400).json({ error: "This link isn't valid. Use the link from the email, or log in to change your email preferences." });
    return null;
  }
  return data;
}

/**
 * GET /api/auth/me/email-preferences
 * The caller's own email preferences.
 * @param {object} req - Express request (req.user set by parseToken).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getMine(req, res) {
  return User.findById(req.user.id)
    .select("_id marketingEmailConsent emailPreferences emailPreferencesUpdatedAt")
    .lean()
    .then(function afterFind(user) {
      if (!user) {
        res.status(404).json({ error: "User not found." });
        return;
      }
      return describeFor(user).then(function send(body) {
        res.status(200).json(body);
      });
    })
    .catch(function onError(err) {
      console.error("getMine email preferences failed:", err);
      res.status(500).json({ error: "Could not load your email preferences." });
    });
}

/**
 * PUT /api/auth/me/email-preferences   Body: { decisions?, account?, event?, announcements? }
 * Change the caller's own preferences (any subset; booleans only).
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function updateMine(req, res) {
  return applyChange(req.user.id, req.body || {})
    .then(function afterChange(result) {
      if (result.errors) {
        res.status(400).json({ error: result.errors.join(" ") });
        return;
      }
      if (!result.user) {
        res.status(404).json({ error: "User not found." });
        return;
      }
      return describeFor(result.user).then(function send(body) {
        res.status(200).json(body);
      });
    })
    .catch(function onError(err) {
      console.error("updateMine email preferences failed:", err);
      res.status(500).json({ error: "Could not save your email preferences." });
    });
}

/**
 * POST /api/auth/email-preferences/lookup   Body: { token }
 * Public: what an email's unsubscribe link points at (its category and the
 * person's current preferences). Changes nothing, so a mail scanner opening
 * the page can't unsubscribe anyone.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function lookupByToken(req, res) {
  var data = tokenFrom(req, res);
  if (!data) {
    return Promise.resolve();
  }
  return User.findById(data.userId)
    .select("_id email marketingEmailConsent emailPreferences emailPreferencesUpdatedAt")
    .lean()
    .then(function afterFind(user) {
      if (!user) {
        res.status(404).json({ error: "There's no account for this link any more." });
        return;
      }
      return describeFor(user).then(function send(body) {
        res.status(200).json(Object.assign({ category: data.category, email: maskEmail(user.email) }, body));
      });
    })
    .catch(function onError(err) {
      console.error("lookupByToken failed:", err);
      res.status(500).json({ error: "Could not load your email preferences." });
    });
}

/**
 * POST /api/auth/email-preferences/update   Body: { token, preferences }
 * Public: change the link owner's optional email preferences (turn the
 * link's category or everything off, or back on). Idempotent.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function updateByToken(req, res) {
  var data = tokenFrom(req, res);
  if (!data) {
    return Promise.resolve();
  }
  return applyChange(data.userId, req.body.preferences)
    .then(function afterChange(result) {
      if (result.errors) {
        res.status(400).json({ error: result.errors.join(" ") });
        return;
      }
      if (!result.user) {
        res.status(404).json({ error: "There's no account for this link any more." });
        return;
      }
      return describeFor(result.user).then(function send(body) {
        res.status(200).json(Object.assign({ category: data.category, email: maskEmail(result.user.email) }, body));
      });
    })
    .catch(function onError(err) {
      console.error("updateByToken failed:", err);
      res.status(500).json({ error: "Could not save your email preferences." });
    });
}

/**
 * POST /api/auth/unsubscribe/one-click?token=
 * RFC 8058 one-click unsubscribe: mail clients POST
 * "List-Unsubscribe=One-Click" here from the List-Unsubscribe header. Turns
 * the email's category off. Security links can't turn anything off.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function oneClick(req, res) {
  var data = tokenFrom(req, res);
  if (!data) {
    return Promise.resolve();
  }
  if (!emailCategories.isOptional(data.category)) {
    res.status(400).json({ error: "These emails can't be turned off." });
    return Promise.resolve();
  }
  var change = {};
  change[data.category] = false;
  return applyChange(data.userId, change)
    .then(function afterChange(result) {
      if (!result.user) {
        res.status(404).json({ error: "There's no account for this link any more." });
        return;
      }
      res.status(200).json({ ok: true, category: data.category });
    })
    .catch(function onError(err) {
      console.error("one-click unsubscribe failed:", err);
      res.status(500).json({ error: "Could not unsubscribe you." });
    });
}

module.exports = {
  getMine: getMine,
  updateMine: updateMine,
  lookupByToken: lookupByToken,
  updateByToken: updateByToken,
  oneClick: oneClick,
  maskEmail: maskEmail,
  describe: describe,
};
