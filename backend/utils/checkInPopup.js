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

// Custom questions from a round's form are chosen as "answers.<question key>".
// They're linked by key, so they keep working when a round's form changes
// labels or order (a key that no longer exists just shows "—").
var ANSWER_PREFIX = "answers.";
var ANSWER_KEY = /^[A-Za-z0-9_-]{1,60}$/;

/**
 * @param {string} key - A popup field key.
 * @returns {boolean} Whether it names a custom question.
 */
function isAnswerField(key) {
  return typeof key === "string" && key.indexOf(ANSWER_PREFIX) === 0 && ANSWER_KEY.test(key.slice(ANSWER_PREFIX.length));
}

/**
 * A form label as plain text: [link text](url) -> "link text", trimmed short.
 * @param {string} label - formConfig label.
 * @returns {string}
 */
function plainLabel(label) {
  var text = String(label || "").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1").trim();
  return text.length > 80 ? text.slice(0, 77) + "…" : text;
}

/**
 * Every field an admin can put on the popup: the built-ins, then each custom
 * question (not resume uploads) from the given rounds, first label wins.
 * @param {Array<object>} rounds - ApplicationRounds with formConfig.
 * @returns {object} { fieldKey: label }
 */
function fieldOptions(rounds) {
  var options = Object.assign({}, FIELD_LABELS);
  (rounds || []).forEach(function eachRound(round) {
    (round.formConfig || []).forEach(function eachField(field) {
      var key = field && ANSWER_PREFIX + field.key;
      if (field && field.type !== "resume" && isAnswerField(key) && !options[key]) {
        options[key] = plainLabel(field.label || field.key);
      }
    });
  });
  return options;
}

/**
 * A stored answer as display text.
 * @param {*} value - The answer.
 * @returns {string}
 */
function formatValue(value) {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

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
    if (FIELD_KEYS.indexOf(key) === -1 && !isAnswerField(key)) {
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
 * @param {Array<object>} [formConfig] - Its round's form, which labels custom questions.
 * @returns {Array<{key: string, label: string, value: string}>|null}
 */
function buildPopup(settings, user, application, formConfig) {
  if (!settings || settings.checkInPopupEnabled === false) {
    return null;
  }
  var fields = Array.isArray(settings.checkInPopupFields) ? settings.checkInPopupFields : DEFAULT_FIELDS;
  var app = application || {};
  var answers = app.answers || {};
  var form = Array.isArray(formConfig) ? formConfig : [];
  return fields
    .filter(function known(key) {
      return FIELD_KEYS.indexOf(key) !== -1 || isAnswerField(key);
    })
    .map(function toRow(key) {
      if (isAnswerField(key)) {
        var questionKey = key.slice(ANSWER_PREFIX.length);
        var question = form.find(function byKey(f) {
          return f && f.key === questionKey;
        });
        return {
          key: key,
          label: question ? plainLabel(question.label || questionKey) : questionKey,
          value: formatValue(answers[questionKey]),
        };
      }
      var value = key === "email" ? user.email : key === "name" ? app.name || user.name : app[key];
      return { key: key, label: FIELD_LABELS[key], value: formatValue(value) };
    });
}

module.exports = {
  FIELD_LABELS: FIELD_LABELS,
  fieldOptions: fieldOptions,
  isAnswerField: isAnswerField,
  DEFAULT_FIELDS: DEFAULT_FIELDS,
  validateFields: validateFields,
  buildPopup: buildPopup,
};
