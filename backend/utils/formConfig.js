"use strict";

// Field types a round's formConfig may declare. Shared between B8 (validating
// submitted answers against a round's config) and B9 (validating the config
// itself when an admin edits it).
var ALLOWED_FIELD_TYPES = ["text", "textarea", "number", "select", "checkbox", "date"];

/**
 * Validate a submitted answers map against a round's formConfig: required
 * fields must be present, and fields with an `options` list must match one
 * of them. Unknown keys (not declared in formConfig) are dropped rather than
 * stored, so the answers map can't be used to smuggle arbitrary data.
 *
 * @param {Array<object>} formConfig - [{ key, label, type, required, options }]
 * @param {object} answers - Submitted { [key]: value } map.
 * @returns {{errors: string[], answers: object}} Validation errors (empty
 *   when valid) and the subset of answers that map to known fields.
 */
function validateAnswers(formConfig, answers) {
  var fields = Array.isArray(formConfig) ? formConfig : [];
  var safeAnswers = answers && typeof answers === "object" ? answers : {};
  var errors = [];
  var cleaned = {};

  fields.forEach(function checkField(field) {
    if (!field || !field.key) {
      return;
    }

    var value = safeAnswers[field.key];
    var isEmpty = value === undefined || value === null || value === "";

    if (field.required && isEmpty) {
      errors.push((field.label || field.key) + " is required.");
      return;
    }

    if (!isEmpty && Array.isArray(field.options) && field.options.length && field.options.indexOf(value) === -1) {
      errors.push((field.label || field.key) + " must be one of: " + field.options.join(", ") + ".");
      return;
    }

    if (!isEmpty) {
      cleaned[field.key] = value;
    }
  });

  return { errors: errors, answers: cleaned };
}

module.exports = {
  ALLOWED_FIELD_TYPES: ALLOWED_FIELD_TYPES,
  validateAnswers: validateAnswers,
};
