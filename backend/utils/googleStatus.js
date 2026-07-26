"use strict";

var OrgSettings = require("../schemas/orgSettings");
var passportUtil = require("./passport");

/**
 * Whether the environment permits Google sign-in: credentials are present AND
 * the env flag isn't explicitly turned off. This is the hard gate an admin
 * cannot override upward (you can't enable Google without credentials).
 * @returns {boolean}
 */
function envAllowsGoogle() {
  return (
    passportUtil.isGoogleConfigured() &&
    String(process.env.GOOGLE_AUTH_ENABLED) !== "false"
  );
}

/**
 * Effective Google-auth availability: env must allow it AND the admin org
 * setting must not have turned it off. Admins can disable it at runtime from
 * the settings panel even when the env allows it.
 * @returns {Promise<boolean>}
 */
function isGoogleEnabled() {
  if (!envAllowsGoogle()) {
    return Promise.resolve(false);
  }
  return OrgSettings.getSingleton().then(function afterLoad(settings) {
    return Boolean(settings.googleAuthEnabled);
  });
}

module.exports = {
  envAllowsGoogle: envAllowsGoogle,
  isGoogleEnabled: isGoogleEnabled,
};
