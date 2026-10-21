"use strict";

/**
 * Per-module feature flags (B25). Each hackathon can switch whole modules on
 * or off at runtime from the admin settings (OrgSettings.features).
 *
 * This file is pure (no database), so the schema, the settings controller, the
 * branding endpoint and requireFeature can all share it.
 *
 * A flag is only OFF when it is explicitly `false`. A missing flag (an older
 * settings document, a module added later, no settings document at all) means
 * ON, so adding a module never locks anyone out and a missing value can never
 * crash a request.
 */

// Every module that can be switched off. To add one: add its key here and in
// the FEATURE_LABELS below, then mount requireFeature("<key>") on its router.
var FEATURE_KEYS = ["meals", "hardware", "workshops", "judging", "raffle"];

var FEATURE_LABELS = {
  meals: "Meals",
  hardware: "Hardware",
  workshops: "Workshops",
  judging: "Judging",
  raffle: "Raffle",
};

/**
 * Whether a module is currently on.
 * @param {object|null} settings - An OrgSettings document or plain object (may be null/empty).
 * @param {string} name - A key from FEATURE_KEYS.
 * @returns {boolean} False only when the flag is explicitly false.
 */
function isEnabled(settings, name) {
  var flags = settings && settings.features;
  return !(flags && flags[name] === false);
}

/**
 * Every flag as a plain `{ key: boolean }` object, defaults filled in.
 * @param {object|null} settings - An OrgSettings document or plain object.
 * @returns {object} e.g. { meals: true, hardware: true, ... }.
 */
function resolve(settings) {
  var out = {};
  FEATURE_KEYS.forEach(function each(key) {
    out[key] = isEnabled(settings, key);
  });
  return out;
}

/**
 * Validate the `features` object of a settings PATCH. Partial: only the keys
 * present are changed. Values must be real booleans (not "false" strings,
 * which would be truthy) and unknown keys are rejected so typos are noticed.
 * @param {*} input - req.body.features.
 * @returns {{errors: string[], update: object}} `update` maps "features.<key>" to a boolean.
 */
function validatePatch(input) {
  var errors = [];
  var update = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["features must be an object like { meals: false }."], update: update };
  }
  Object.keys(input).forEach(function each(key) {
    if (FEATURE_KEYS.indexOf(key) === -1) {
      errors.push("Unknown feature \"" + key + "\". Known features: " + FEATURE_KEYS.join(", ") + ".");
    } else if (typeof input[key] !== "boolean") {
      errors.push("features." + key + " must be true or false.");
    } else {
      update["features." + key] = input[key];
    }
  });
  return { errors: errors, update: update };
}

module.exports = {
  FEATURE_KEYS: FEATURE_KEYS,
  FEATURE_LABELS: FEATURE_LABELS,
  isEnabled: isEnabled,
  resolve: resolve,
  validatePatch: validatePatch,
};
