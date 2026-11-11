"use strict";

var validator = require("validator");

var formConfigUtil = require("./formConfig");

// Staff corrections of a submitted application (PATCH
// /api/admin/applications/:id/details): which parts may change, how each value
// is cleaned and checked, and what counts as a change for the audit trail.
// Pure functions; the controller does the database work.

// Plain text profile fields and their longest accepted length.
var TEXT_FIELDS = {
  name: 200,
  phone: 50,
  gender: 100,
  pronouns: 100,
  education: 100,
  university: 300,
  major: 300,
  allergies: 1000,
};
var SKILL_FIELDS = ["programmingSkills", "hardwareSkills", "otherSkills"];
var TSHIRT_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL", ""];
var SOCIAL_LINKS = ["linkedin", "github", "website"];
var EXPERIENCE_FLAGS = ["attendedBefore", "attendedThisBefore"];

// Every field `fields` may set. Anything else (status, flags, applicant,
// round, resume, ...) is refused: decisions and flags have their own routes.
var EDITABLE_FIELDS = Object.keys(TEXT_FIELDS).concat(
  ["age", "tshirtSize", "socials", "experience"],
  SKILL_FIELDS
);
var TOP_LEVEL_KEYS = ["fields", "answers", "user"];
var USER_KEYS = ["name", "email"];

var TEXT_ANSWER_MAX = 1000;
var TEXTAREA_ANSWER_MAX = 10000;
var LINK_MAX = 500;
var MAX_SKILLS = 50;
var MAX_OTHER_LINKS = 20;

/**
 * Whether a value is a plain object (not null, not an array).
 * @param {*} value - Anything.
 * @returns {boolean}
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Clean one text value: trimmed string within `max` characters.
 * @param {*} value - Submitted value (null/undefined read as "").
 * @param {number} max - Longest accepted length.
 * @returns {{value: string}|{error: string}}
 */
function cleanText(value, max) {
  if (value === undefined || value === null) {
    return { value: "" };
  }
  if (typeof value !== "string" && typeof value !== "number") {
    return { error: "must be text." };
  }
  var text = String(value).trim();
  if (text.length > max) {
    return { error: "must be " + max + " characters or fewer." };
  }
  return { value: text };
}

/**
 * Clean a list of skills: distinct, trimmed, non-empty strings.
 * @param {*} value - Submitted value.
 * @returns {{value: Array<string>}|{error: string}}
 */
function cleanSkills(value) {
  if (value === undefined || value === null) {
    return { value: [] };
  }
  if (!Array.isArray(value)) {
    return { error: "must be a list." };
  }
  var out = [];
  for (var i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      return { error: "must be a list of text." };
    }
    var item = value[i].trim();
    if (item.length > 100) {
      return { error: "entries must be 100 characters or fewer." };
    }
    if (item && out.indexOf(item) === -1) {
      out.push(item);
    }
  }
  if (out.length > MAX_SKILLS) {
    return { error: "can have at most " + MAX_SKILLS + " entries." };
  }
  return { value: out };
}

/**
 * Clean a boolean that may arrive as "true"/"false".
 * @param {*} value - Submitted value.
 * @returns {boolean|null} The boolean, or null when it isn't one.
 */
function toBoolean(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false" || value === undefined || value === null) return false;
  return null;
}

/**
 * Clean the socials object, starting from what is stored so a partial object
 * (just `github`) leaves the other links alone.
 * @param {*} value - Submitted socials.
 * @param {object} current - Stored socials.
 * @returns {{value: object}|{error: string}}
 */
function cleanSocials(value, current) {
  if (!isPlainObject(value)) {
    return { error: "must be an object." };
  }
  var base = current || {};
  var out = {
    linkedin: base.linkedin || "",
    github: base.github || "",
    website: base.website || "",
    other: (base.other || []).map(function copy(link) {
      return { label: link.label || "", url: link.url || "" };
    }),
  };
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (SOCIAL_LINKS.indexOf(key) !== -1) {
      var text = cleanText(value[key], LINK_MAX);
      if (text.error) return { error: key + " " + text.error };
      out[key] = text.value;
    } else if (key === "other") {
      if (!Array.isArray(value.other) || value.other.length > MAX_OTHER_LINKS) {
        return { error: "other must be a list of up to " + MAX_OTHER_LINKS + " links." };
      }
      var links = [];
      for (var j = 0; j < value.other.length; j++) {
        var link = value.other[j];
        if (!isPlainObject(link)) return { error: "other links must be { label, url }." };
        var label = cleanText(link.label, 100);
        var url = cleanText(link.url, LINK_MAX);
        if (label.error || url.error) return { error: "other links must be short text." };
        if (label.value || url.value) links.push({ label: label.value, url: url.value });
      }
      out.other = links;
    } else {
      return { error: "has an unknown link: " + key + "." };
    }
  }
  return { value: out };
}

/**
 * Clean the experience object, starting from what is stored.
 * @param {*} value - Submitted experience.
 * @param {object} current - Stored experience.
 * @returns {{value: object}|{error: string}}
 */
function cleanExperience(value, current) {
  if (!isPlainObject(value)) {
    return { error: "must be an object." };
  }
  var base = current || {};
  var out = {
    attendedBefore: Boolean(base.attendedBefore),
    hackathonsAttended: Number(base.hackathonsAttended) || 0,
    attendedThisBefore: Boolean(base.attendedThisBefore),
  };
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (EXPERIENCE_FLAGS.indexOf(key) !== -1) {
      var flag = toBoolean(value[key]);
      if (flag === null) return { error: key + " must be true or false." };
      out[key] = flag;
    } else if (key === "hackathonsAttended") {
      var count = value[key] === "" || value[key] === null ? 0 : Number(value[key]);
      if (!Number.isInteger(count) || count < 0 || count > 1000) {
        return { error: "hackathonsAttended must be a whole number from 0 to 1000." };
      }
      out.hackathonsAttended = count;
    } else {
      return { error: "has an unknown field: " + key + "." };
    }
  }
  return { value: out };
}

/**
 * Clean one built-in profile field.
 * @param {string} key - One of EDITABLE_FIELDS.
 * @param {*} value - Submitted value.
 * @param {object} application - The stored application (for partial objects).
 * @returns {{value: *}|{error: string}} `value` undefined means "clear it".
 */
function cleanField(key, value, application) {
  if (TEXT_FIELDS[key]) {
    return cleanText(value, TEXT_FIELDS[key]);
  }
  if (SKILL_FIELDS.indexOf(key) !== -1) {
    return cleanSkills(value);
  }
  if (key === "age") {
    if (value === undefined || value === null || value === "") {
      return { value: undefined };
    }
    var age = Number(value);
    if (!Number.isInteger(age) || age < 0 || age > 150) {
      return { error: "must be a whole number from 0 to 150." };
    }
    return { value: age };
  }
  if (key === "tshirtSize") {
    var size = value === undefined || value === null ? "" : value;
    if (TSHIRT_SIZES.indexOf(size) === -1) {
      return { error: "must be one of: " + TSHIRT_SIZES.filter(Boolean).join(", ") + "." };
    }
    return { value: size };
  }
  if (key === "socials") {
    return cleanSocials(value, application.socials);
  }
  return cleanExperience(value, application.experience);
}

/**
 * Clean one custom answer against its formConfig question. Staff edits use
 * the submission rules (utils/formConfig.validateAnswers: required, choices,
 * "Other") plus type and length checks, except that a required checkbox (a
 * consent statement) doesn't have to be ticked: staff can't consent for the
 * applicant, and making them re-tick it would be pretending to.
 *
 * @param {object} field - formConfig question.
 * @param {*} value - Submitted answer.
 * @returns {{value: *}|{error: string}} `value` undefined means "no answer".
 */
function cleanAnswer(field, value) {
  var name = field.label || field.key;
  var candidate = value;

  if (field.type === "checkbox") {
    var flag = toBoolean(candidate);
    if (flag === null) return { error: name + " must be true or false." };
    candidate = flag;
  } else if (field.type === "text" || field.type === "textarea") {
    var text = cleanText(candidate, field.type === "text" ? TEXT_ANSWER_MAX : TEXTAREA_ANSWER_MAX);
    if (text.error) return { error: name + " " + text.error };
    candidate = text.value;
  } else if (field.type === "number") {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
      if (!Number.isFinite(Number(candidate))) return { error: name + " must be a number." };
      candidate = typeof candidate === "string" ? candidate.trim() : candidate;
    } else {
      candidate = "";
    }
  } else if (field.type === "date") {
    var raw = candidate === undefined || candidate === null ? "" : String(candidate).trim();
    if (raw && !validator.isISO8601(raw)) return { error: name + " must be a date." };
    candidate = raw;
  } else if (field.type === "select") {
    if (candidate !== undefined && candidate !== null && typeof candidate !== "string") {
      return { error: name + " must be one of its choices." };
    }
  }

  var rules = Object.assign({}, field, {
    required: field.type === "checkbox" ? false : Boolean(field.required),
  });
  var answers = {};
  answers[field.key] = candidate;
  var check = formConfigUtil.validateAnswers([rules], answers, { hasResume: true });
  if (check.errors.length) {
    return { error: check.errors[0] };
  }
  // validateAnswers leaves empty answers out of what it returns.
  if (!Object.prototype.hasOwnProperty.call(check.answers, field.key)) {
    return { value: field.type === "checkbox" ? false : undefined };
  }
  return { value: check.answers[field.key] };
}

/**
 * Comparable form of a stored or cleaned value, so "" and missing, or a
 * Mongoose array and a plain one, count as the same.
 * @param {*} value - Anything.
 * @returns {string}
 */
function comparable(value) {
  if (value === undefined || value === null || value === "") return "";
  var plain = value && typeof value.toObject === "function" ? value.toObject() : value;
  return JSON.stringify(plain);
}

/**
 * Check a staff edit and work out what it changes.
 *
 * @param {object} input
 * @param {object} input.body - Request body `{ fields?, answers?, user? }`.
 * @param {object} input.application - Stored Application (plain or document).
 * @param {object} input.round - Its ApplicationRound (formConfig, profileFields).
 * @param {object} input.user - The applicant's User (name, email).
 * @returns {object} `{ error, errors }` when invalid (errors keyed like
 *   "fields.phone", "answers.<key>", "user.email"), else `{ fields, answers,
 *   user, changed }`: the values to write (only those that differ from what
 *   is stored; an `undefined` value means unset) and their names for the audit.
 */
function buildEdit(input) {
  var body = input.body;
  var application = input.application;
  var round = input.round || {};
  var user = input.user || {};
  var errors = {};
  var result = { fields: {}, answers: {}, user: {}, changed: [] };

  if (!isPlainObject(body)) {
    return { error: "Send { fields, answers, user }.", errors: {} };
  }
  var unknownTop = Object.keys(body).filter(function notAllowed(key) {
    return TOP_LEVEL_KEYS.indexOf(key) === -1;
  });
  if (unknownTop.length) {
    return {
      error: "These can't be changed here: " + unknownTop.join(", ") + ". Use the decision and flag actions instead.",
      errors: {},
    };
  }
  for (var t = 0; t < TOP_LEVEL_KEYS.length; t++) {
    var part = body[TOP_LEVEL_KEYS[t]];
    if (part !== undefined && !isPlainObject(part)) {
      return { error: TOP_LEVEL_KEYS[t] + " must be an object.", errors: {} };
    }
  }

  // ---- Built-in profile fields --------------------------------------------
  var fields = body.fields || {};
  var badFields = Object.keys(fields).filter(function notEditable(key) {
    return EDITABLE_FIELDS.indexOf(key) === -1;
  });
  if (badFields.length) {
    return { error: "These fields can't be changed here: " + badFields.join(", ") + ".", errors: {} };
  }
  var required = (round.profileFields && Array.isArray(round.profileFields.required) && round.profileFields.required) || [];
  Object.keys(fields).forEach(function eachField(key) {
    var cleaned = cleanField(key, fields[key], application);
    var label = formConfigUtil.PROFILE_FIELD_LABELS[key] || (key === "name" ? "Full name" : key);
    if (cleaned.error) {
      errors["fields." + key] = label + " " + cleaned.error;
      return;
    }
    var empty = comparable(cleaned.value) === "" || (Array.isArray(cleaned.value) && cleaned.value.length === 0);
    if (empty && (key === "name" || required.indexOf(key) !== -1)) {
      errors["fields." + key] = label + " is required.";
      return;
    }
    if (key === "socials" || key === "experience") {
      // Report each part that changed, e.g. "socials.github".
      var before = application[key] || {};
      Object.keys(cleaned.value).forEach(function eachPart(partKey) {
        if (comparable(before[partKey]) !== comparable(cleaned.value[partKey])) {
          result.changed.push(key + "." + partKey);
        }
      });
      if (comparable(before) !== comparable(cleaned.value)) {
        result.fields[key] = cleaned.value;
      }
      return;
    }
    if (comparable(application[key]) !== comparable(cleaned.value)) {
      result.fields[key] = cleaned.value;
      result.changed.push(key);
    }
  });

  // ---- Custom answers -------------------------------------------------------
  var answers = body.answers || {};
  var formConfig = Array.isArray(round.formConfig) ? round.formConfig : [];
  var stored = application.answers || {};
  Object.keys(answers).forEach(function eachAnswer(key) {
    var field = formConfig.find(function byKey(f) {
      return f && f.key === key;
    });
    if (!field) {
      errors["answers." + key] = "This round's form has no question " + key + ".";
      return;
    }
    if (field.type === "resume") {
      errors["answers." + key] = "Resumes can't be changed here.";
      return;
    }
    var cleaned = cleanAnswer(field, answers[key]);
    if (cleaned.error) {
      errors["answers." + key] = cleaned.error;
      return;
    }
    var before = Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : undefined;
    var same =
      field.type === "checkbox" ? Boolean(before) === Boolean(cleaned.value) : comparable(before) === comparable(cleaned.value);
    if (!same) {
      result.answers[key] = cleaned.value;
      result.changed.push("answers." + key);
    }
  });

  // ---- Account (User) -------------------------------------------------------
  var account = body.user || {};
  var badUser = Object.keys(account).filter(function notAllowed(key) {
    return USER_KEYS.indexOf(key) === -1;
  });
  if (badUser.length) {
    return { error: "Only the account's name and email can be changed here.", errors: {} };
  }
  if (account.name !== undefined) {
    var name = cleanText(account.name, 200);
    if (name.error || !name.value) {
      errors["user.name"] = name.error ? "Account name " + name.error : "Account name is required.";
    } else if (name.value !== user.name) {
      result.user.name = name.value;
      result.changed.push("user.name");
    }
  }
  if (account.email !== undefined) {
    var email = typeof account.email === "string" ? account.email.trim().toLowerCase() : "";
    if (!email || !validator.isEmail(email)) {
      errors["user.email"] = "Enter a valid email address.";
    } else if (email !== String(user.email || "").toLowerCase()) {
      result.user.email = email;
      result.changed.push("user.email");
    }
  }

  var messages = Object.keys(errors).map(function message(key) {
    return errors[key];
  });
  if (messages.length) {
    return { error: messages.join(" "), errors: errors };
  }
  return result;
}

module.exports = {
  EDITABLE_FIELDS: EDITABLE_FIELDS,
  buildEdit: buildEdit,
  cleanAnswer: cleanAnswer,
};
