"use strict";

// Field types a round's formConfig may declare. Shared between B8 (validating
// submitted answers against a round's config) and B9 (validating the config
// itself when an admin edits it).
//
// "resume" is a file upload: the file travels as the multipart `resume` part
// and is stored privately (Application.resumeBlobName), not in `answers`. A
// form may have at most one.
// "multiselect" is a set of checkboxes ("select all that apply"); its answer is
// an array of the chosen options.
var ALLOWED_FIELD_TYPES = ["text", "textarea", "number", "select", "multiselect", "checkbox", "date", "resume"];

// Longest free-text "Other" answer accepted on a select/multiselect with
// `allowOther`.
var OTHER_MAX_LENGTH = 300;

// Built-in profile questions (fixed fields on the application, not formConfig)
// that a round can mark required, with the names used in error messages.
var PROFILE_FIELD_LABELS = {
  phone: "Phone",
  age: "Age",
  gender: "Gender",
  pronouns: "Pronouns",
  education: "Education level",
  university: "University / School",
  major: "Major / Field of study",
  tshirtSize: "T-shirt size",
  allergies: "Dietary restrictions / allergies",
  programmingSkills: "Programming skills",
  hardwareSkills: "Hardware skills",
};

// Built-in select questions whose choices a round can replace.
var PROFILE_OPTION_FIELDS = ["education", "gender"];

/**
 * Whether a submitted value counts as "not answered" for a field.
 * @param {object} field - formConfig field.
 * @param {*} value - Submitted value.
 * @returns {boolean}
 */
function isEmptyAnswer(field, value) {
  if (value === undefined || value === null || value === "") return true;
  // An unticked checkbox arrives as `false`, which must not satisfy `required`.
  if (field.type === "checkbox" && value === false) return true;
  if (field.type === "multiselect" && Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * A free-text "Other" answer is allowed when the field opts in and the text
 * is a short, non-empty string.
 * @param {object} field - formConfig field.
 * @param {*} value - The candidate value.
 * @returns {boolean}
 */
function isAllowedOther(field, value) {
  return Boolean(field.allowOther) && typeof value === "string" && value.trim() !== "" && value.length <= OTHER_MAX_LENGTH;
}

/**
 * Clean a multiselect answer: an array of trimmed, distinct, non-empty
 * strings. A lone string (e.g. from a hand-built request) counts as one choice.
 * @param {*} value - Submitted value.
 * @returns {Array<string>|null} The cleaned list, or null when it isn't a list of strings.
 */
function normalizeMultiselect(value) {
  var list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list)) return null;
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] !== "string") return null;
    var item = list[i].trim();
    if (item && !seen[item]) {
      seen[item] = true;
      out.push(item);
    }
  }
  return out;
}

/**
 * Validate a submitted answers map against a round's formConfig: required
 * fields must be present, and fields with an `options` list must match one
 * of them (or be a free-text "Other" where the field allows it). Unknown keys
 * (not declared in formConfig) are dropped rather than stored, so the answers
 * map can't be used to smuggle arbitrary data.
 *
 * @param {Array<object>} formConfig - [{ key, label, type, required, options, allowOther }]
 * @param {object} answers - Submitted { [key]: value } map.
 * @param {object} [context] - Facts about the submission beyond `answers`.
 * @param {boolean} [context.hasResume] - Whether the application has (or is
 *   uploading) a resume; satisfies a required "resume" field.
 * @returns {{errors: string[], answers: object}} Validation errors (empty
 *   when valid) and the subset of answers that map to known fields.
 */
function validateAnswers(formConfig, answers, context) {
  var fields = Array.isArray(formConfig) ? formConfig : [];
  var safeAnswers = answers && typeof answers === "object" ? answers : {};
  var hasResume = Boolean(context && context.hasResume);
  var errors = [];
  var cleaned = {};

  fields.forEach(function checkField(field) {
    if (!field || !field.key) {
      return;
    }
    var name = field.label || field.key;

    // The file itself is handled by the upload; a value typed into `answers`
    // for this key is never stored, so it can't pose as an uploaded resume.
    if (field.type === "resume") {
      if (field.required && !hasResume) {
        errors.push(name + " is required.");
      }
      return;
    }

    var value = safeAnswers[field.key];
    var options = Array.isArray(field.options) ? field.options : [];

    if (field.type === "multiselect" && !isEmptyAnswer(field, value)) {
      value = normalizeMultiselect(value);
      if (value === null) {
        errors.push(name + " must be a list of choices.");
        return;
      }
    }

    if (isEmptyAnswer(field, value)) {
      if (field.required) {
        errors.push(name + " is required.");
      }
      return;
    }

    if (field.type === "multiselect") {
      var others = value.filter(function notAnOption(item) {
        return options.indexOf(item) === -1;
      });
      var badOther = others.length > 1 || (others.length === 1 && !isAllowedOther(field, others[0]));
      if (options.length && badOther) {
        errors.push(name + " must be chosen from: " + options.join(", ") + (field.allowOther ? " (plus one \"Other\")." : "."));
        return;
      }
    } else if (options.length && options.indexOf(value) === -1 && !(field.type === "select" && isAllowedOther(field, value))) {
      errors.push(name + " must be one of: " + options.join(", ") + ".");
      return;
    }

    cleaned[field.key] = value;
  });

  return { errors: errors, answers: cleaned };
}

/**
 * Validate the shape of a formConfig payload itself (as opposed to answers
 * submitted against it) — used when an admin creates/edits a round. Each
 * field must have a unique string `key`, a string `label`, and a `type` from
 * ALLOWED_FIELD_TYPES; `required` and `allowOther` (if present) must be
 * booleans, `description` a string, and `options` an array.
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
  // No prototype, so a field key like "constructor" isn't mistaken for a duplicate.
  var seenKeys = Object.create(null);
  var resumeFields = 0;

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

    if (field.type === "resume") {
      resumeFields += 1;
      if (resumeFields === 2) {
        errors.push("A form can have only one resume upload question.");
      }
    }

    if (field.required !== undefined && typeof field.required !== "boolean") {
      errors.push(label + " required must be a boolean.");
    }

    if (field.allowOther !== undefined && typeof field.allowOther !== "boolean") {
      errors.push(label + " allowOther must be a boolean.");
    }

    if (field.description !== undefined && typeof field.description !== "string") {
      errors.push(label + " description must be a string.");
    }

    if (field.options !== undefined && !Array.isArray(field.options)) {
      errors.push(label + " options must be an array.");
    }
  });

  return { errors: errors };
}

/**
 * Validate a round's settings for the built-in profile questions:
 *   { required: ["phone", ...], options: { education: [...], gender: [...] } }
 * Both parts are optional.
 *
 * @param {*} profileFields - The raw payload value.
 * @returns {{errors: string[]}} Errors (empty when valid or undefined).
 */
function validateProfileFieldsShape(profileFields) {
  if (profileFields === undefined) {
    return { errors: [] };
  }
  if (!profileFields || typeof profileFields !== "object" || Array.isArray(profileFields)) {
    return { errors: ["profileFields must be an object."] };
  }

  var errors = [];
  var required = profileFields.required;
  if (required !== undefined) {
    if (!Array.isArray(required)) {
      errors.push("profileFields.required must be an array.");
    } else {
      required.forEach(function checkKey(key) {
        if (!Object.prototype.hasOwnProperty.call(PROFILE_FIELD_LABELS, key)) {
          errors.push("profileFields.required has an unknown field: " + key + ".");
        }
      });
    }
  }

  var options = profileFields.options;
  if (options !== undefined) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      errors.push("profileFields.options must be an object.");
    } else {
      Object.keys(options).forEach(function checkOptions(key) {
        if (PROFILE_OPTION_FIELDS.indexOf(key) === -1) {
          errors.push("profileFields.options can only set: " + PROFILE_OPTION_FIELDS.join(", ") + ".");
          return;
        }
        var list = options[key];
        var valid = Array.isArray(list) && list.length > 0 && list.every(function isText(item) {
          return typeof item === "string" && item.trim() !== "";
        });
        if (!valid) {
          errors.push("profileFields.options." + key + " must be a non-empty list of choices.");
        }
      });
    }
  }

  return { errors: errors };
}

/**
 * Check the built-in profile answers against the round's required list.
 *
 * @param {object} profileFields - The round's profileFields (may be empty).
 * @param {object} profile - Built-in fields as stored (see buildProfile).
 * @returns {string[]} Errors, empty when every required field is filled in.
 */
function validateProfile(profileFields, profile) {
  var required = profileFields && Array.isArray(profileFields.required) ? profileFields.required : [];
  var values = profile || {};
  var errors = [];

  required.forEach(function checkRequired(key) {
    var value = values[key];
    var empty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "") ||
      (typeof value === "number" && Number.isNaN(value)) ||
      (Array.isArray(value) && value.length === 0);
    if (empty && PROFILE_FIELD_LABELS[key]) {
      errors.push(PROFILE_FIELD_LABELS[key] + " is required.");
    }
  });

  return errors;
}

module.exports = {
  ALLOWED_FIELD_TYPES: ALLOWED_FIELD_TYPES,
  OTHER_MAX_LENGTH: OTHER_MAX_LENGTH,
  PROFILE_FIELD_LABELS: PROFILE_FIELD_LABELS,
  PROFILE_OPTION_FIELDS: PROFILE_OPTION_FIELDS,
  validateAnswers: validateAnswers,
  validateFormConfigShape: validateFormConfigShape,
  validateProfileFieldsShape: validateProfileFieldsShape,
  validateProfile: validateProfile,
};
