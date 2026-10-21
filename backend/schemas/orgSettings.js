"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

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
    checkInPopupFields: {
      type: [String],
      default: function () {
        return ["name", "pronouns", "tshirtSize"];
      },
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
