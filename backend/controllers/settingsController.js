"use strict";

var OrgSettings = require("../schemas/orgSettings");
var googleStatus = require("../utils/googleStatus");

/**
 * GET /api/admin/settings — full org settings (admin only).
 * Also reports whether the environment even permits Google, so the UI can show
 * why a toggle is unavailable.
 * @param {object} _req
 * @param {object} res
 * @returns {Promise<void>}
 */
function getSettings(_req, res) {
  return OrgSettings.getSingleton()
    .then(function afterLoad(settings) {
      res.status(200).json({
        settings: settings,
        googleEnvAllowed: googleStatus.envAllowsGoogle(),
      });
    })
    .catch(function onError(err) {
      console.error("getSettings failed:", err);
      res.status(500).json({ error: "Could not load settings." });
    });
}

/**
 * PATCH /api/admin/settings — update org settings (admin only).
 * Body: { googleAuthEnabled?: boolean, publicApplications?: boolean }
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function updateSettings(req, res) {
  var update = {};
  if (req.body && req.body.googleAuthEnabled !== undefined) {
    update.googleAuthEnabled = Boolean(req.body.googleAuthEnabled);
  }
  if (req.body && req.body.publicApplications !== undefined) {
    update.publicApplications = Boolean(req.body.publicApplications);
  }

  return OrgSettings.findOneAndUpdate(
    { key: "default" },
    { $set: update, $setOnInsert: { key: "default" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  )
    .then(function afterUpdate(settings) {
      res.status(200).json({ settings: settings });
    })
    .catch(function onError(err) {
      console.error("updateSettings failed:", err);
      res.status(500).json({ error: "Could not update settings." });
    });
}

module.exports = {
  getSettings: getSettings,
  updateSettings: updateSettings,
};
