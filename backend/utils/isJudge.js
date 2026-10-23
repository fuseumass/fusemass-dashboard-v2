"use strict";

var requireRole = require("./currentRole").requireRole;
/**
 * Check the current database role so demotion revokes access immediately.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {function} next - Express next callback.
 * @returns {Promise<void>|void}
 */
var isJudge = requireRole(
  ["judge", "admin"],
  "Judge or admin access required.",
);
module.exports = isJudge;
