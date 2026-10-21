"use strict";

var OrgSettings = require("../schemas/orgSettings");
var googleStatus = require("../utils/googleStatus");
var checkInPopup = require("../utils/checkInPopup");

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
        // Fields an admin can put on the check-in popup: { key: label }.
        checkInPopupFieldOptions: checkInPopup.FIELD_LABELS,
      });
    })
    .catch(function onError(err) {
      console.error("getSettings failed:", err);
      res.status(500).json({ error: "Could not load settings." });
    });
}

/**
 * PATCH /api/admin/settings — update org settings (admin only).
 * Body: { googleAuthEnabled?, publicApplications?, checkInPopupEnabled?: boolean,
 *         checkInPopupFields?: string[] }
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
  if (req.body && req.body.checkInPopupEnabled !== undefined) {
    update.checkInPopupEnabled = Boolean(req.body.checkInPopupEnabled);
  }
  if (req.body && req.body.checkInPopupFields !== undefined) {
    var popupCheck = checkInPopup.validateFields(req.body.checkInPopupFields);
    if (popupCheck.errors.length) {
      res.status(400).json({ error: popupCheck.errors.join(" ") });
      return Promise.resolve();
    }
    update.checkInPopupFields = popupCheck.fields;
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
