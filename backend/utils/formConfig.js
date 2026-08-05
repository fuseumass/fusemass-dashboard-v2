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

/**
 * Validate the shape of a formConfig payload itself (as opposed to answers
 * submitted against it) — used when an admin creates/edits a round. Each
 * field must have a unique string `key`, a string `label`, and a `type` from
 * ALLOWED_FIELD_TYPES; `required` (if present) must be a boolean and
 * `options` (if present) must be an array.
 *
 * @param {*} formConfig - The raw payload value to validate.
 * @returns {{errors: string[]}} Validation errors (empty when valid, which
 *   also covers `undefined` — an absent formConfig means "leave unchanged").
 */
function validateFormConfigShape(formConfig) {
  if (formConfig === undefined) {
    return { errors: [] };
  }
  if (!Array.isArray(formConfig)) {
    return { errors: ["formConfig must be an array."] };
  }

  var errors = [];
  var seenKeys = {};

  formConfig.forEach(function checkField(field, index) {
    var label = "formConfig[" + index + "]";

    if (!field || typeof field !== "object") {
      errors.push(label + " must be an object.");
      return;
    }

    if (!field.key || typeof field.key !== "string") {
      errors.push(label + " is missing a string key.");
      return;
    }
    label += " (" + field.key + ")";

    if (seenKeys[field.key]) {
      errors.push(label + " has a key that's already used by another field.");
    }
    seenKeys[field.key] = true;

    if (!field.label || typeof field.label !== "string") {
      errors.push(label + " is missing a string label.");
    }

    if (ALLOWED_FIELD_TYPES.indexOf(field.type) === -1) {
      errors.push(label + " type must be one of: " + ALLOWED_FIELD_TYPES.join(", ") + ".");
    }

    if (field.required !== undefined && typeof field.required !== "boolean") {
      errors.push(label + " required must be a boolean.");
    }

    if (field.options !== undefined && !Array.isArray(field.options)) {
      errors.push(label + " options must be an array.");
    }
  });

  return { errors: errors };
}

module.exports = {
  ALLOWED_FIELD_TYPES: ALLOWED_FIELD_TYPES,
  validateAnswers: validateAnswers,
  validateFormConfigShape: validateFormConfigShape,
};
