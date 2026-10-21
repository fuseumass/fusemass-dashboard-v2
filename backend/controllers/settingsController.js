"use strict";

var OrgSettings = require("../schemas/orgSettings");
var googleStatus = require("../utils/googleStatus");
var checkInPopup = require("../utils/checkInPopup");
var branding = require("../utils/branding");
var features = require("../utils/features");
var azureBlob = require("../utils/azureBlob");
var orgSettingsCache = require("../utils/orgSettingsCache");
var brandingController = require("./brandingController");
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
        // Modules that can be switched off, in display order: [{ key, label }].
        featureOptions: features.FEATURE_KEYS.map(function option(key) {
          return { key: key, label: features.FEATURE_LABELS[key] };
        }),
        // What visitors get right now (admin setting, else server env, else
        // default), and what they'd get with no admin overrides.
        effectiveBranding: branding.resolve(results[0]),
        brandingDefaults: branding.resolve(null),
        // False when Azure isn't set up: logo upload is then unavailable (a
        // pasted https image URL still works).
        imageUploadsEnabled: azureBlob.isAzureConfigured(),
      });
    })
    .catch(function onError(err) {
      console.error("getSettings failed:", err);
      res.status(500).json({ error: "Could not load settings." });
    });
}

/**
 * PATCH /api/admin/settings — update org settings (admin only).
 * Body: { googleAuthEnabled?, publicApplications?, autoFlagApplications?,
 *         checkInPopupEnabled?: boolean, checkInPopupFields?: string[],
 *         teamMaxSize?: number,
 *         features?: { meals?, hardware?, workshops?, judging?, raffle?: boolean },
 *         branding?: { orgName?, primaryColor?, secondaryColor?, accentColor?
 *                      (#RRGGBB), logoUrl?, logoDarkUrl?, faviconUrl? (https URL) } }
 * Every part is optional and partial; "" or null in `branding` clears a field
 * back to the server default. Nothing is saved unless the whole request is valid.
 * @param {object} req
 * @param {object} res
 * @returns {Promise<void>}
 */
function updateSettings(req, res) {
  var update = {};
  var replacedSlots = [];
  if (req.body && req.body.features !== undefined) {
    var featureCheck = features.validatePatch(req.body.features);
    if (featureCheck.errors.length) {
      res.status(400).json({ error: featureCheck.errors.join(" ") });
      return Promise.resolve();
    }
    Object.assign(update, featureCheck.update);
  }
  if (req.body && req.body.branding !== undefined) {
    var brandingCheck = branding.validatePatch(req.body.branding);
    if (brandingCheck.errors.length) {
      res.status(400).json({ error: brandingCheck.errors.join(" ") });
      return Promise.resolve();
    }
    Object.assign(update, brandingCheck.update);
    replacedSlots = brandingCheck.replacedSlots;
  }
  if (req.body && req.body.googleAuthEnabled !== undefined) {
    update.googleAuthEnabled = Boolean(req.body.googleAuthEnabled);
  }
  if (req.body && req.body.publicApplications !== undefined) {
    update.publicApplications = Boolean(req.body.publicApplications);
  }
  if (req.body && req.body.autoFlagApplications !== undefined) {
    update.autoFlagApplications = Boolean(req.body.autoFlagApplications);
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

  // Pasting an image URL replaces an uploaded image in that slot; remember
  // which files that orphans so they can be deleted after the save.
  var before = replacedSlots.length ? OrgSettings.getSingleton() : Promise.resolve(null);

  return before
    .then(function afterBefore(previous) {
      var orphaned = replacedSlots.map(function fileOf(slot) {
        return previous && previous.branding ? previous.branding[branding.SLOTS[slot].fileField] : "";
      });
      return OrgSettings.findOneAndUpdate(
        { key: "default" },
        { $set: update, $setOnInsert: { key: "default" } },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
      ).then(function afterSave(settings) {
        // Admin writes show up on this instance immediately (see orgSettingsCache).
        orgSettingsCache.clear();
        orphaned.forEach(brandingController.discardImage);
        return settings;
      });
    })
    .then(function afterUpdate(settings) {
      res.status(200).json({ settings: settings, effectiveBranding: branding.resolve(settings) });
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
