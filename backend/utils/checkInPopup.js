"use strict";

// The check-in popup: after each successful first check-in, staff see a few
// facts about the attendee in large type (to greet them correctly and hand
// over the right shirt). Admins choose the fields in Settings.
var FIELD_LABELS = {
  name: "Name",
  pronouns: "Pronouns",
  tshirtSize: "T-shirt size",
  allergies: "Dietary restrictions",
  university: "School",
  major: "Major",
  age: "Age",
  email: "Email",
};
var FIELD_KEYS = Object.keys(FIELD_LABELS);
var DEFAULT_FIELDS = ["name", "pronouns", "tshirtSize"];

/**
 * Check an admin's chosen popup fields.
 * @param {*} fields - Submitted value.
 * @returns {{errors: string[], fields: Array<string>}} Errors, and the fields
 *   deduplicated in the order given.
 */
function validateFields(fields) {
  if (!Array.isArray(fields)) {
    return { errors: ["checkInPopupFields must be an array."], fields: [] };
  }
  var out = [];
  var errors = [];
  fields.forEach(function checkField(key) {
    if (FIELD_KEYS.indexOf(key) === -1) {
      errors.push("Unknown check-in popup field: " + key + ".");
    } else if (out.indexOf(key) === -1) {
      out.push(key);
    }
  });
  return { errors: errors, fields: out };
}

/**
 * The popup for one check-in, or null when it's switched off.
 * @param {object} settings - OrgSettings document.
 * @param {object} user - The attendee's User.
 * @param {object} [application] - Their application (accepted, or latest when forced).
 * @returns {Array<{key: string, label: string, value: string}>|null}
 */
function buildPopup(settings, user, application) {
  if (!settings || settings.checkInPopupEnabled === false) {
    return null;
  }
  var fields = Array.isArray(settings.checkInPopupFields) ? settings.checkInPopupFields : DEFAULT_FIELDS;
  var app = application || {};
  return fields
    .filter(function known(key) {
      return FIELD_KEYS.indexOf(key) !== -1;
    })
    .map(function toRow(key) {
      var value = key === "email" ? user.email : key === "name" ? app.name || user.name : app[key];
      return {
        key: key,
        label: FIELD_LABELS[key],
        value: value === undefined || value === null || value === "" ? "—" : String(value),
      };
    });
}

module.exports = {
  FIELD_LABELS: FIELD_LABELS,
  DEFAULT_FIELDS: DEFAULT_FIELDS,
  validateFields: validateFields,
  buildPopup: buildPopup,
};
