"use strict";

var OrgSettings = require("../schemas/orgSettings");
var googleStatus = require("../utils/googleStatus");
var checkInPopup = require("../utils/checkInPopup");
var ApplicationRound = require("../schemas/applicationRound");

/**
 * GET /api/admin/settings — full org settings (admin only).
 * Also reports whether the environment even permits Google, so the UI can show
 * why a toggle is unavailable.
 * @param {object} _req
 * @param {object} res
 * @returns {Promise<void>}
 */
function getSettings(_req, res) {
  return Promise.all([OrgSettings.getSingleton(), ApplicationRound.find({}).select("formConfig").sort({ order: 1 }).lean()])
    .then(function afterLoad(results) {
      res.status(200).json({
        settings: results[0],
        googleEnvAllowed: googleStatus.envAllowsGoogle(),
        // Fields an admin can put on the check-in popup: { key: label }, the
        // built-ins plus every round's custom questions ("answers.<key>").
        checkInPopupFieldOptions: checkInPopup.fieldOptions(results[1]),
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
  if (req.body && req.body.teamMaxSize !== undefined) {
    var size = Number(req.body.teamMaxSize);
    if (!Number.isInteger(size) || size < 1 || size > 10) {
      res.status(400).json({ error: "teamMaxSize must be a whole number from 1 to 10." });
      return Promise.resolve();
    }
    update.teamMaxSize = size;
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
