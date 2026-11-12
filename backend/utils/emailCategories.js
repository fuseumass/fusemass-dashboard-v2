"use strict";

/**
 * Which kind of email each template is, for email preferences. The single
 * place that decides what a person can opt out of.
 *
 *   security       credentials or the person's own action (password reset,
 *                  email verification, judge invite links). Always sent, no
 *                  unsubscribe link.
 *   decisions      application received, accepted, rejected, waitlisted.
 *   account        account setup and setup reminders.
 *   event          check-in, teams, hardware, raffles, workshops, judging.
 *   announcements  news sent to many people at once.
 *
 * Every category except security is optional. A template that isn't listed
 * here (a custom one an admin made) counts as an announcement.
 */

var SECURITY = "security";
var DEFAULT_CATEGORY = "announcements";
var OPTIONAL = ["decisions", "account", "event", "announcements"];
var ALL = [SECURITY].concat(OPTIONAL);

var LABELS = {
  security: "Security and sign-in",
  decisions: "Application decisions",
  account: "Account setup",
  event: "Event updates",
  announcements: "Announcements",
};

var DESCRIPTIONS = {
  security: "Password resets, email verification and invite links. These are always sent.",
  decisions: "When your application is received, accepted, waitlisted or not selected.",
  account: "Links to set up your account and reminders to finish setting it up.",
  event: "Check-in, teams, hardware, workshop sign-ups and reminders, raffles and judging.",
  announcements: "News and reminders sent to everyone or to a group.",
};

// How each category reads inside a sentence ("turn off event update emails").
var NOUNS = {
  security: "security emails",
  decisions: "application decision emails",
  account: "account setup emails",
  event: "event update emails",
  announcements: "announcements",
};

var TEMPLATE_CATEGORIES = {
  password_reset: "security",
  verify_email: "security",
  judge_invite: "security",
  test_email: "security",

  application_received: "decisions",
  application_accepted: "decisions",
  application_rejected: "decisions",
  application_waitlisted: "decisions",

  account_setup: "account",
  account_setup_reminder: "account",

  checked_in: "event",
  team_invite: "event",
  team_conflict: "event",
  hardware_checkout: "event",
  hardware_return: "event",
  hardware_reminder: "event",
  hardware_team_change: "event",
  raffle_winner: "event",
  workshop_signup: "event",
  workshop_changed: "event",
  workshop_cancelled: "event",
  workshop_reminder: "event",
  workshop_organizer_added: "event",
  judging_table_assigned: "event",

  announcement: "announcements",
  workshop_digest: "announcements",
};

/**
 * @param {string} key - Template key.
 * @returns {string} Its category (announcements for unknown keys).
 */
function forTemplate(key) {
  var found = TEMPLATE_CATEGORIES[String(key || "")];
  if (found) {
    return found;
  }
  // Setup-reminder variants added later keep their meaning without an edit here.
  if (/^account_setup/.test(String(key || ""))) {
    return "account";
  }
  return DEFAULT_CATEGORY;
}

/**
 * The category an outbox row is sent under. An explicit `preferenceCategory`
 * on the row wins; a bulk "announcement" is an announcement whatever the
 * template; an admin's own test send always goes out.
 * @param {object} row - EmailLog document or entry `{ templateKey, category, preferenceCategory }`.
 * @returns {string}
 */
function forRow(row) {
  if (!row) {
    return DEFAULT_CATEGORY;
  }
  if (row.category === "test") {
    return SECURITY;
  }
  if (row.preferenceCategory && ALL.indexOf(row.preferenceCategory) !== -1) {
    return row.preferenceCategory;
  }
  if (row.category === "announcement") {
    return "announcements";
  }
  return forTemplate(row.templateKey);
}

/**
 * @param {string} category - A category key.
 * @returns {boolean} Whether people can turn it off.
 */
function isOptional(category) {
  return OPTIONAL.indexOf(category) !== -1;
}

/**
 * A person's preferences as a plain object, one boolean per optional
 * category. Announcements are stored as `marketingEmailConsent` (opt-in, off
 * until the person says yes); the others in `emailPreferences` (on unless
 * turned off).
 * @param {object|null} user - User document or lean object.
 * @returns {{decisions: boolean, account: boolean, event: boolean, announcements: boolean}}
 */
function preferencesOf(user) {
  var stored = (user && user.emailPreferences) || {};
  return {
    decisions: stored.decisions !== false,
    account: stored.account !== false,
    event: stored.event !== false,
    announcements: Boolean(user && user.marketingEmailConsent),
  };
}

/**
 * Whether a person gets email of a category.
 * @param {object|null} user - User (with emailPreferences and marketingEmailConsent).
 * @param {string} category - A category key.
 * @returns {boolean}
 */
function allows(user, category) {
  if (!isOptional(category)) {
    return true;
  }
  return preferencesOf(user)[category] === true;
}

/**
 * Turn a partial `{ category: boolean }` object into a Mongo $set. Unknown
 * keys and non-booleans are errors.
 * @param {*} input - Request body preferences.
 * @returns {{errors: Array<string>, set: object}}
 */
function toUpdate(input) {
  var errors = [];
  var set = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { errors: ["Preferences must be an object like { event: false }."], set: set };
  }
  Object.keys(input).forEach(function each(key) {
    if (!isOptional(key)) {
      errors.push("Unknown email category \"" + key + "\".");
    } else if (typeof input[key] !== "boolean") {
      errors.push(key + " must be true or false.");
    } else if (key === "announcements") {
      set.marketingEmailConsent = input[key];
    } else {
      set["emailPreferences." + key] = input[key];
    }
  });
  if (!errors.length && !Object.keys(set).length) {
    errors.push("Nothing to change.");
  }
  if (!errors.length) {
    set.emailPreferencesUpdatedAt = new Date();
  }
  return { errors: errors, set: set };
}

/**
 * The categories for the UI, in display order.
 * @returns {Array<{key: string, label: string, description: string, optional: boolean}>}
 */
function list() {
  return ALL.map(function describe(key) {
    return { key: key, label: LABELS[key], description: DESCRIPTIONS[key], optional: isOptional(key) };
  });
}

/**
 * @returns {object} Category key -> template keys, for documentation and the UI.
 */
function templatesByCategory() {
  var out = {};
  ALL.forEach(function init(key) {
    out[key] = [];
  });
  Object.keys(TEMPLATE_CATEGORIES).forEach(function each(key) {
    out[TEMPLATE_CATEGORIES[key]].push(key);
  });
  return out;
}

module.exports = {
  SECURITY: SECURITY,
  DEFAULT_CATEGORY: DEFAULT_CATEGORY,
  OPTIONAL: OPTIONAL,
  ALL: ALL,
  LABELS: LABELS,
  NOUNS: NOUNS,
  TEMPLATE_CATEGORIES: TEMPLATE_CATEGORIES,
  forTemplate: forTemplate,
  forRow: forRow,
  isOptional: isOptional,
  preferencesOf: preferencesOf,
  allows: allows,
  toUpdate: toUpdate,
  list: list,
  templatesByCategory: templatesByCategory,
};
