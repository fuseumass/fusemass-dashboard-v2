"use strict";

var mongoose = require("mongoose");

var featureUtil = require("../utils/features");
var brandingUtil = require("../utils/branding");

var Schema = mongoose.Schema;

// One on/off flag per module, ON unless an admin turns it off (utils/features).
var featureFields = {};
featureUtil.FEATURE_KEYS.forEach(function addFlag(key) {
  featureFields[key] = { type: Boolean, default: true };
});

// A colour field: empty (use the server default) or exactly #RRGGBB.
var colorField = {
  type: String,
  default: "",
  validate: {
    validator: function isEmptyOrHex(value) {
      return !value || brandingUtil.isHexColor(value);
    },
    message: "Colours must be written as #RRGGBB.",
  },
};

/**
 * Organization-wide settings. Stored as a single document (a singleton). Admins
 * edit these from the settings panel. Values here can override environment
 * defaults at runtime (e.g. turning Google sign-in off without a redeploy).
 */

var orgSettingsSchema = new Schema(
  {
    // Singleton guard: always the string "default" so findOneAndUpdate upserts
    // exactly one document.
    key: {
      type: String,
      default: "default",
      unique: true,
    },
    // Admin override for Google OAuth. When false, Google sign-in is disabled
    // even if credentials are configured. Defaults to true; effective
    // availability also requires the env credentials to be present.
    googleAuthEnabled: {
      type: Boolean,
      default: true,
    },
    // Accept applications without an account. When true, the site's home page
    // is the application form and POST /api/applications/public takes
    // submissions by email; accepted applicants are emailed a link to set a
    // password (see adminController.decideApplication).
    publicApplications: {
      type: Boolean,
      default: false,
    },
    // Check-in popup (see utils/checkInPopup): shown to staff after each
    // successful check-in, with these fields from the attendee's application.
    checkInPopupEnabled: {
      type: Boolean,
      default: true,
    },
    // Largest team allowed (members, plus pending invites while forming).
    teamMaxSize: {
      type: Number,
      default: 4,
      min: 1,
      max: 10,
    },
    checkInPopupFields: {
      type: [String],
      default: function () {
        return ["name", "pronouns", "tshirtSize"];
      },
    },
    // Per-module on/off switches (B25), all on by default. Flipping one off
    // makes that module's routes answer 404 (utils/requireFeature). The keys
    // come from utils/features so a new module is added in one place.
    features: featureFields,
    // Runtime branding overrides (B28). An empty string means "not set here":
    // the effective value then falls back to the server env, then a built-in
    // default. Don't read these directly for display; use utils/branding.resolve,
    // which also re-validates whatever was stored.
    branding: {
      orgName: { type: String, default: "", maxlength: brandingUtil.MAX_ORG_NAME },
      primaryColor: colorField,
      secondaryColor: colorField,
      accentColor: colorField,
      // External https image URLs the admin pasted in...
      logoUrl: { type: String, default: "" },
      logoDarkUrl: { type: String, default: "" },
      faviconUrl: { type: String, default: "" },
      // ...or names of images uploaded to the branding container (these win).
      logoFile: { type: String, default: "" },
      logoDarkFile: { type: String, default: "" },
      faviconFile: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

/**
 * Load the singleton settings document, creating it with defaults if missing.
 * @returns {Promise<object>} The settings document.
 */
orgSettingsSchema.statics.getSingleton = function getSingleton() {
  return this.findOneAndUpdate(
    { key: "default" },
    { $setOnInsert: { key: "default" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.model("OrgSettings", orgSettingsSchema);
