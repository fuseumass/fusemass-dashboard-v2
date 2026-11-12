"use strict";

var applicationFlags = require("./applicationFlags");

// Finding and merging duplicate applications. Pure functions; the controller
// (controllers/applicationDuplicatesController) does the database work.

// Fields a merge can choose between, per application. `answers.<key>` entries
// are added for every custom question either application answered.
var MERGE_FIELDS = [
  "name",
  "phone",
  "age",
  "gender",
  "pronouns",
  "education",
  "university",
  "major",
  "allergies",
  "tshirtSize",
  "socials.linkedin",
  "socials.github",
  "socials.website",
  "socials.other",
  "experience.attendedBefore",
  "experience.hackathonsAttended",
  "experience.attendedThisBefore",
  "programmingSkills",
  "hardwareSkills",
  "otherSkills",
  "resume",
];

// A key shared by more people than this is not a duplicate signal (a shared
// household number, a placeholder name), and would make a huge group.
var MAX_BUCKET = 6;

var GMAIL_DOMAINS = ["gmail.com", "googlemail.com"];

/**
 * A name reduced for comparing: accents removed, lowercase, punctuation gone,
 * spacing collapsed. "  José   NÚÑEZ " and "jose nunez" are the same.
 *
 * @param {*} name - Name as typed.
 * @returns {string} "" when there is nothing to compare (one short word).
 */
function nameKey(name) {
  var key = String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  // A single word ("Sam") is too common to suggest anyone from.
  return key.indexOf(" ") === -1 ? "" : key;
}

/**
 * The address Gmail would deliver to: dots in the part before @ are ignored
 * and "+tag" is dropped, so "j.doe+hack@gmail.com" is "jdoe@gmail.com".
 * Other providers give "" (their dots and plus signs may matter).
 *
 * @param {*} email - Email address.
 * @returns {string}
 */
function gmailKey(email) {
  var parts = String(email || "").trim().toLowerCase().split("@");
  if (parts.length !== 2 || GMAIL_DOMAINS.indexOf(parts[1]) === -1) {
    return "";
  }
  var local = parts[0].split("+")[0].replace(/\./g, "");
  return local ? local + "@gmail.com" : "";
}

/**
 * The id pair as stored in a dismissal: smaller id first.
 *
 * @param {*} one - Application id.
 * @param {*} two - Application id.
 * @returns {Array<string>} [smaller, larger] as strings.
 */
function sortedPair(one, two) {
  var a = String(one);
  var b = String(two);
  return a < b ? [a, b] : [b, a];
}

/**
 * Group applications that look like the same person.
 *
 * Two applications are linked when they share a phone number (last 10
 * digits), a full name (normalized) or a Gmail-equivalent email, unless the
 * pair was dismissed. Links join into groups (A~B and B~C is one group).
 *
 * @param {Array<object>} applications - Active applications:
 *   `{ _id, name, phone, phoneKey?, applicant: { email } }`.
 * @param {Array<Array<string>>} [dismissed] - Dismissed pairs, as from sortedPair.
 * @returns {Array<{applications: Array<object>, reasons: Array<string>}>}
 *   Largest groups first. `reasons` is a subset of "phone", "name", "email".
 */
function suggestGroups(applications, dismissed) {
  var dismissedSet = {};
  (dismissed || []).forEach(function remember(pair) {
    dismissedSet[pair[0] + "|" + pair[1]] = true;
  });

  var byId = {};
  var buckets = { phone: {}, name: {}, email: {} };
  applications.forEach(function index(application) {
    var id = String(application._id);
    byId[id] = application;
    var keys = {
      phone: application.phoneKey || applicationFlags.phoneKey(application.phone),
      name: nameKey(application.name),
      email: gmailKey(application.applicant && application.applicant.email),
    };
    Object.keys(keys).forEach(function add(kind) {
      if (keys[kind]) {
        buckets[kind][keys[kind]] = buckets[kind][keys[kind]] || [];
        buckets[kind][keys[kind]].push(id);
      }
    });
  });

  // Union-find over the links.
  var parent = {};
  function find(id) {
    while (parent[id] !== id) {
      parent[id] = parent[parent[id]];
      id = parent[id];
    }
    return id;
  }
  var reasonsByRoot = {};
  var links = [];
  Object.keys(buckets).forEach(function eachKind(kind) {
    Object.keys(buckets[kind]).forEach(function eachBucket(key) {
      var ids = buckets[kind][key];
      if (ids.length < 2 || ids.length > MAX_BUCKET) {
        return;
      }
      for (var i = 0; i < ids.length; i += 1) {
        for (var j = i + 1; j < ids.length; j += 1) {
          var pair = sortedPair(ids[i], ids[j]);
          if (!dismissedSet[pair[0] + "|" + pair[1]]) {
            links.push({ a: ids[i], b: ids[j], kind: kind });
          }
        }
      }
    });
  });
  links.forEach(function init(link) {
    parent[link.a] = parent[link.a] || link.a;
    parent[link.b] = parent[link.b] || link.b;
  });
  links.forEach(function join(link) {
    parent[find(link.a)] = find(link.b);
  });
  links.forEach(function collect(link) {
    var root = find(link.a);
    reasonsByRoot[root] = reasonsByRoot[root] || {};
    reasonsByRoot[root][link.kind] = true;
  });

  var members = {};
  Object.keys(parent).forEach(function group(id) {
    var root = find(id);
    members[root] = members[root] || [];
    members[root].push(byId[id]);
  });

  return Object.keys(members)
    .map(function toGroup(root) {
      return {
        applications: members[root].sort(function oldestFirst(x, y) {
          return new Date(x.createdAt) - new Date(y.createdAt);
        }),
        reasons: ["phone", "name", "email"].filter(function present(kind) {
          return reasonsByRoot[root][kind];
        }),
      };
    })
    .sort(function biggestFirst(x, y) {
      return y.applications.length - x.applications.length;
    });
}

/**
 * Whether a value counts as filled in.
 * @param {*} value - Any stored value.
 * @returns {boolean}
 */
function hasValue(value) {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

/**
 * Read one mergeable field from an application document.
 *
 * @param {object} application - Application document.
 * @param {string} field - An entry of MERGE_FIELDS, or "answers.<key>".
 * @returns {*} The stored value.
 */
function readField(application, field) {
  if (field === "resume") {
    return application.resumeBlobName || "";
  }
  if (field.indexOf("answers.") === 0) {
    return (application.answers || {})[field.slice("answers.".length)];
  }
  return application.get(field);
}

/**
 * Every field a merge of these two applications may choose between.
 *
 * @param {object} one - Application document.
 * @param {object} two - Application document.
 * @returns {Array<string>}
 */
function mergeFieldList(one, two) {
  var keys = {};
  [one, two].forEach(function eachApplication(application) {
    Object.keys(application.answers || {}).forEach(function add(key) {
      keys["answers." + key] = true;
    });
  });
  return MERGE_FIELDS.concat(Object.keys(keys).sort());
}

/**
 * Work out the merged values. A field with an explicit choice takes that
 * application's value; any other field keeps the kept application's value and
 * fills it from the other one only when the kept one is blank.
 *
 * @param {object} kept - Application document that survives.
 * @param {object} gone - Application document that is removed.
 * @param {object} choices - { <field>: "kept" | "gone" } explicit choices.
 * @param {Array<string>} fields - From mergeFieldList.
 * @returns {Array<{field: string, value: *}>} Only the fields that change on
 *   `kept`, i.e. taken from `gone` and different from what `kept` has.
 */
function resolveMerge(kept, gone, choices, fields) {
  var changes = [];
  fields.forEach(function eachField(field) {
    var mine = readField(kept, field);
    var theirs = readField(gone, field);
    var fromGone;
    if (choices[field] === "gone") {
      fromGone = true;
    } else if (choices[field] === "kept") {
      fromGone = false;
    } else {
      fromGone = !hasValue(mine) && hasValue(theirs);
    }
    if (fromGone && JSON.stringify(mine) !== JSON.stringify(theirs)) {
      changes.push({ field: field, value: theirs });
    }
  });
  return changes;
}

/**
 * Which application to keep by default: the accepted one, otherwise the
 * older one.
 *
 * @param {object} one - Application document.
 * @param {object} two - Application document.
 * @returns {object} `one` or `two`.
 */
function defaultKept(one, two) {
  var oneAccepted = one.status === "accepted";
  var twoAccepted = two.status === "accepted";
  if (oneAccepted !== twoAccepted) {
    return oneAccepted ? one : two;
  }
  return new Date(one.createdAt) <= new Date(two.createdAt) ? one : two;
}

module.exports = {
  MERGE_FIELDS: MERGE_FIELDS,
  nameKey: nameKey,
  gmailKey: gmailKey,
  sortedPair: sortedPair,
  suggestGroups: suggestGroups,
  readField: readField,
  mergeFieldList: mergeFieldList,
  resolveMerge: resolveMerge,
  defaultKept: defaultKept,
  hasValue: hasValue,
};
