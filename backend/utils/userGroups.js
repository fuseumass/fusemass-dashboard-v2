"use strict";

var mongoose = require("mongoose");
var activeApplications = require("./activeApplications");

var applicationStatus = require("./applicationStatus");
var applicationScope = require("./applicationScope");
var autoAccept = require("./autoAccept");

// Filters for the admin "User groups" page (controllers/userGroupsController).
// Everything a request asks for is checked here and turned into MongoDB
// filters built from fixed operators: user input only ever lands in a value
// position (an $in list, an equality, an escaped pattern), never as a key or
// operator, so a value like {"$ne": null} can't change what a query means.

// Query-string keys the group routes accept. Anything else is a 400, so a
// typo never silently widens a group.
var ALLOWED_PARAMS = ["round", "domain", "subdomains", "status", "dietary", "answer", "checkedIn", "flagged"];

// Question types that can be filtered on: their answers come from a list.
var FILTER_TYPES = ["select", "multiselect", "checkbox"];

// Food-restriction answers that mean "nothing" (compared trimmed, lower case).
var NO_RESTRICTION = ["", "none", "n/a", "na", "no"];

// dietary=<value>: who to keep.
var DIETARY_VALUES = ["any", "restrictions", "accommodations", "none"];

// Limits, so one request can't build an enormous query.
var MAX_DOMAINS = 20;
var MAX_ANSWERS = 50;
var MAX_VALUE_LENGTH = 500;

// Question keys are used inside a field path ("answers.<key>"), so only plain
// characters: no dots, no "$".
var KEY_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

// A meal-accommodations question, however the organizers worded it: mentions
// accommodation together with meals, food or diet.
var MEAL_PATTERN = /meal|food|diet/i;
var ACCOMMODATION_PATTERN = /accommodat/i;
// A "yes" answer to it: a ticked checkbox, or a choice that starts with "Yes".
var YES_PATTERN = /^\s*yes\b/i;

/**
 * The questions in a form that can be filtered on (choice and yes/no).
 * @param {Array<object>} formConfig - A round's formConfig.
 * @returns {Array<{key: string, label: string, type: string, options: Array<string>}>}
 */
function filterableQuestions(formConfig) {
  var seen = {};
  return (Array.isArray(formConfig) ? formConfig : []).filter(function usable(field) {
    if (!field || typeof field.key !== "string" || !KEY_PATTERN.test(field.key) || seen[field.key]) {
      return false;
    }
    if (FILTER_TYPES.indexOf(field.type) === -1) {
      return false;
    }
    seen[field.key] = true;
    return true;
  }).map(function toQuestion(field) {
    return {
      key: field.key,
      label: applicationScope.plainLabel(field.label || field.key),
      type: field.type,
      options: field.type === "checkbox"
        ? ["Yes", "No"]
        : (Array.isArray(field.options) ? field.options : []).filter(function isText(option) {
            return typeof option === "string";
          }),
    };
  });
}

/**
 * The form's meal-accommodations questions (usually one; none on forms that
 * don't ask).
 * @param {Array<object>} formConfig - A round's formConfig.
 * @returns {Array<{key: string, label: string, type: string}>}
 */
function mealQuestions(formConfig) {
  return filterableQuestions(formConfig).filter(function isMeal(question) {
    var text = question.key + " " + question.label;
    return MEAL_PATTERN.test(text) && ACCOMMODATION_PATTERN.test(text);
  });
}

/**
 * Read a list parameter: one value or several (?status=a&status=b), each
 * optionally comma separated when `split` is set.
 * @param {*} value - req.query[name].
 * @param {boolean} split - Split each value on commas.
 * @returns {Array<string>|null} The values, or null when they aren't strings.
 */
function readList(value, split) {
  if (value === undefined || value === "") {
    return [];
  }
  var raw = Array.isArray(value) ? value : [value];
  if (!raw.every(function isString(item) { return typeof item === "string"; })) {
    return null;
  }
  var out = [];
  raw.forEach(function add(item) {
    (split ? item.split(",") : [item]).forEach(function push(part) {
      var trimmed = split ? part.trim() : part;
      if (trimmed !== "" && out.indexOf(trimmed) === -1) {
        out.push(trimmed);
      }
    });
  });
  return out;
}

/**
 * Read a true/false parameter.
 * @param {*} value - req.query[name].
 * @returns {boolean|null|undefined} undefined when absent, null when invalid.
 */
function readBoolean(value) {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return null;
}

/**
 * Check the ?round= parameter on its own (before the round is loaded).
 * @param {object} query - req.query.
 * @returns {{error: string}|{round: string}} round is "" when not given.
 */
function readRoundParam(query) {
  var round = query ? query.round : undefined;
  if (round === undefined || round === "") {
    return { round: "" };
  }
  if (typeof round !== "string" || !mongoose.isValidObjectId(round)) {
    return { error: "round is not a valid id." };
  }
  return { round: round };
}

/**
 * Validate the group filters in a query string against a round's form.
 *
 * @param {object} query - req.query.
 * @param {object} round - The round ({ formConfig }).
 * @returns {{error: string}|{filters: object}} filters: { domains,
 *   includeSubdomains, statuses, dietary, answers: [{key, values}], checkedIn,
 *   flagged } (absent filters are empty lists / undefined).
 */
function parseFilters(query, round) {
  query = query || {};
  var unknown = Object.keys(query).filter(function isUnknown(key) {
    return ALLOWED_PARAMS.indexOf(key) === -1;
  });
  if (unknown.length) {
    return { error: "Unknown filter: " + unknown.join(", ") + "." };
  }

  // Email domains, normalized the same way as domain auto-accept.
  var domainInput = readList(query.domain, true);
  if (domainInput === null) {
    return { error: "domain must be text." };
  }
  var domains = [];
  for (var i = 0; i < domainInput.length; i++) {
    var domain = autoAccept.normalizeDomain(domainInput[i]);
    if (!domain) {
      return { error: JSON.stringify(domainInput[i]) + " isn't an email domain." };
    }
    if (domains.indexOf(domain) === -1) {
      domains.push(domain);
    }
  }
  if (domains.length > MAX_DOMAINS) {
    return { error: "At most " + MAX_DOMAINS + " domains." };
  }
  var includeSubdomains = readBoolean(query.subdomains);
  if (includeSubdomains === null) {
    return { error: "subdomains must be true or false." };
  }

  var statuses = readList(query.status, true);
  if (statuses === null || statuses.some(function bad(status) {
    return applicationStatus.APPLICATION_STATUSES.indexOf(status) === -1;
  })) {
    return { error: "status must be one or more of: " + applicationStatus.APPLICATION_STATUSES.join(", ") + "." };
  }

  var dietary = query.dietary === undefined || query.dietary === "" ? "" : query.dietary;
  if (dietary && (typeof dietary !== "string" || DIETARY_VALUES.indexOf(dietary) === -1)) {
    return { error: "dietary must be one of: " + DIETARY_VALUES.join(", ") + "." };
  }

  var checkedIn = readBoolean(query.checkedIn);
  if (checkedIn === null) {
    return { error: "checkedIn must be true or false." };
  }
  var flagged = readBoolean(query.flagged);
  if (flagged === null) {
    return { error: "flagged must be true or false." };
  }

  // answer=<question key>:<choice>, repeated. Choices of one question are
  // OR'd; different questions are AND'd. Values may hold commas, so they are
  // never split.
  var answerInput = readList(query.answer, false);
  if (answerInput === null) {
    return { error: "answer must be text, as <question key>:<choice>." };
  }
  if (answerInput.length > MAX_ANSWERS) {
    return { error: "At most " + MAX_ANSWERS + " answer filters." };
  }
  var questions = {};
  filterableQuestions(round && round.formConfig).forEach(function index(question) {
    questions[question.key] = question;
  });
  var byKey = {};
  var order = [];
  for (var j = 0; j < answerInput.length; j++) {
    var colon = answerInput[j].indexOf(":");
    var key = colon === -1 ? answerInput[j] : answerInput[j].slice(0, colon);
    var value = colon === -1 ? "" : answerInput[j].slice(colon + 1);
    var question = Object.prototype.hasOwnProperty.call(questions, key) ? questions[key] : null;
    if (!question) {
      return { error: JSON.stringify(key) + " isn't a choice question on this round's form." };
    }
    if (!value || value.length > MAX_VALUE_LENGTH) {
      return { error: "Each answer filter needs a choice, as <question key>:<choice>." };
    }
    if (question.type === "checkbox" && value !== "Yes" && value !== "No") {
      return { error: question.label + " can only be filtered by Yes or No." };
    }
    if (!byKey[key]) {
      byKey[key] = [];
      order.push(key);
    }
    if (byKey[key].indexOf(value) === -1) {
      byKey[key].push(value);
    }
  }

  return {
    filters: {
      domains: domains,
      includeSubdomains: includeSubdomains === true,
      statuses: statuses,
      dietary: dietary,
      answers: order.map(function toFilter(questionKey) {
        return { key: questionKey, type: questions[questionKey].type, values: byKey[questionKey] };
      }),
      checkedIn: checkedIn,
      flagged: flagged,
    },
  };
}

/**
 * The MongoDB condition for one answer filter.
 * @param {{key: string, type: string, values: Array<string>}} filter - From parseFilters.
 * @returns {object}
 */
function answerCondition(filter) {
  var path = "answers." + filter.key;
  var condition = {};
  if (filter.type === "checkbox") {
    var yes = filter.values.indexOf("Yes") !== -1;
    var no = filter.values.indexOf("No") !== -1;
    if (yes && no) {
      return {};
    }
    condition[path] = yes ? true : { $ne: true };
    return condition;
  }
  // Matches a single choice, or any element of a multiselect list.
  condition[path] = { $in: filter.values.slice() };
  return condition;
}

/**
 * An aggregation expression: whether the application lists a food
 * restriction (anything but empty / "none" / "n/a" / "na" / "no").
 * @returns {object}
 */
function restrictionExpression() {
  return {
    $not: [
      {
        $in: [
          { $toLower: { $trim: { input: { $toString: { $ifNull: ["$allergies", ""] } } } } },
          NO_RESTRICTION,
        ],
      },
    ],
  };
}

/**
 * An aggregation expression: whether the application answered yes to one of
 * the meal-accommodations questions.
 * @param {Array<{key: string}>} questions - From mealQuestions.
 * @returns {object}
 */
function accommodationExpression(questions) {
  if (!questions.length) {
    return { $literal: false };
  }
  return {
    $or: questions.map(function toExpression(question) {
      var path = "$answers." + question.key;
      return {
        $anyElementTrue: [
          {
            $map: {
              input: { $cond: [{ $isArray: path }, path, [{ $ifNull: [path, null] }]] },
              as: "v",
              in: {
                $or: [
                  { $eq: ["$$v", true] },
                  {
                    $and: [
                      { $eq: [{ $type: "$$v" }, "string"] },
                      { $regexMatch: { input: "$$v", regex: YES_PATTERN.source, options: "i" } },
                    ],
                  },
                ],
              },
            },
          },
        ],
      };
    }),
  };
}

/**
 * The aggregation pipeline (over applications) for a group: the round's
 * applications that match every filter, each with `_user` ({ name, email,
 * checkedIn }), `_domain`, `_restriction` and `_accommodation` added.
 *
 * @param {object} round - The round ({ _id, formConfig }).
 * @param {object} filters - From parseFilters.
 * @param {string} usersCollection - The users collection name.
 * @returns {Array<object>}
 */
function buildPipeline(round, filters, usersCollection) {
  var match = activeApplications.active({
    round: new mongoose.Types.ObjectId(String(round._id)),
    status: filters.statuses.length ? { $in: filters.statuses.slice() } : { $ne: "draft" },
  });
  if (filters.flagged === true) match.flagged = true;
  if (filters.flagged === false) match.flagged = { $ne: true };
  var answerConditions = filters.answers.map(answerCondition).filter(function nonEmpty(condition) {
    return Object.keys(condition).length > 0;
  });
  if (answerConditions.length) {
    match.$and = answerConditions;
  }

  var userMatch = {};
  if (filters.domains.length) {
    userMatch["_user.email"] = autoAccept.emailPattern(filters.domains, filters.includeSubdomains);
  }
  if (filters.checkedIn === true) userMatch["_user.checkedIn"] = true;
  if (filters.checkedIn === false) userMatch["_user.checkedIn"] = { $ne: true };

  var dietaryMatch = {};
  if (filters.dietary === "restrictions") dietaryMatch._restriction = true;
  if (filters.dietary === "accommodations") dietaryMatch._accommodation = true;
  if (filters.dietary === "any") dietaryMatch.$or = [{ _restriction: true }, { _accommodation: true }];
  if (filters.dietary === "none") {
    dietaryMatch._restriction = false;
    dietaryMatch._accommodation = false;
  }

  var pipeline = [
    { $match: match },
    {
      $lookup: {
        from: usersCollection,
        let: { applicantId: "$applicant" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$applicantId"] } } },
          { $project: { _id: 1, name: 1, email: 1, checkedIn: 1 } },
        ],
        as: "_user",
      },
    },
    { $unwind: "$_user" },
  ];
  if (Object.keys(userMatch).length) {
    pipeline.push({ $match: userMatch });
  }
  pipeline.push({
    $addFields: {
      _domain: { $toLower: { $arrayElemAt: [{ $split: [{ $ifNull: ["$_user.email", ""] }, "@"] }, -1] } },
      _restriction: restrictionExpression(),
      _accommodation: accommodationExpression(mealQuestions(round.formConfig)),
    },
  });
  if (Object.keys(dietaryMatch).length) {
    pipeline.push({ $match: dietaryMatch });
  }
  return pipeline;
}

/**
 * Pick the round a group covers when none was asked for: the newest open
 * round, otherwise the newest round.
 * @param {Array<object>} rounds - Every round ({ isOpen, createdAt }).
 * @returns {object|null}
 */
function defaultRound(rounds) {
  var sorted = (rounds || []).slice().sort(function newestFirst(a, b) {
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });
  var open = sorted.filter(function isOpen(round) {
    return round.isOpen;
  });
  return open[0] || sorted[0] || null;
}

module.exports = {
  ALLOWED_PARAMS: ALLOWED_PARAMS,
  NO_RESTRICTION: NO_RESTRICTION,
  DIETARY_VALUES: DIETARY_VALUES,
  filterableQuestions: filterableQuestions,
  mealQuestions: mealQuestions,
  readRoundParam: readRoundParam,
  parseFilters: parseFilters,
  buildPipeline: buildPipeline,
  defaultRound: defaultRound,
};
