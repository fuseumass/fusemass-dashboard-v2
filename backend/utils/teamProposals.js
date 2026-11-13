"use strict";

// Team builder (controllers/teamBuilderController.js): turn the free-text
// "list your teammates" answers on applications into proposed teams.
//
// Everything here is pure (no database): the controller loads applications,
// accounts and teams, hands them over as plain objects, and executes the plan
// this file returns. That keeps the messy parsing testable on its own
// (test/teamProposals.test.js).
//
// How grouping works:
//   1. Every email in an applicant's answer is extracted (lowercased), and the
//      names written next to them are kept as "listed as" labels.
//   2. Each in-scope applicant is joined to every email they listed (and to
//      other applicants whose full name they wrote without an email, when that
//      name matches exactly one applicant). People are compared by a match key
//      that folds Gmail aliases (dots, +tags, googlemail.com).
//   3. Connected components of that graph are candidate groups. Listed
//      emails with no account or application are members too: they get an
//      invite and can accept it after signing up.
//   4. A group is only "ready" when everyone who wrote a list agrees on it.
//      Each lister A claims the team T(A): A plus everyone A listed. People
//      who listed nobody are silent and agree by default. If every lister has
//      the same T the group is consistent (a team can be created); if two
//      listers differ, or the group is bigger than the team limit, it is a
//      conflict and no team is created: the listers are told to sort it out
//      on the dashboard (see conflictDetails).

var validator = require("validator");

// Loose on purpose: real answers have uppercase, plus tags and odd separators.
var EMAIL_PATTERN = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

// Separators between the people in an answer. Hyphens are not one: they sit
// between a name and its email ("Garv Utekar- g@x.edu") and inside names.
var SEGMENT_SPLIT = /[\n\r;,()[\]{}|/\\\t]+|\s+and\s+|\s*&\s*|\s+\+\s+/i;

// Words that mean "this is a sentence, not a name" ("forming", "but we might
// need more people?", "N/A", "still looking").
var NOISE_WORDS = [
  "a", "about", "alone", "and", "any", "anyone", "are", "at", "be", "but", "can", "decide", "decided",
  "do", "dont", "don't", "email", "emails", "etc", "event", "find", "finding", "for", "form", "forming",
  "formed", "friend", "friends", "group", "has", "have", "here", "i", "idk", "if", "in", "is", "it",
  "join", "later", "looking", "maybe", "me", "member", "members", "might", "more", "my", "n/a", "na",
  "need", "needs", "no", "nobody", "none", "not", "of", "on", "one", "or", "other", "others",
  "partner", "partners", "pending", "people", "person", "please", "same", "school", "solo", "someone",
  "still", "sure", "tba", "tbd", "team", "teammate", "teammates", "teams", "the", "them", "they",
  "this", "to", "undecided", "unknown", "us", "want", "we", "will", "with", "without", "yes", "yet",
  "you", "umass", "university", "college", "student", "students",
];
var NOISE = {};
NOISE_WORDS.forEach(function mark(word) {
  NOISE[word] = true;
});

var GMAIL_DOMAINS = { "gmail.com": true, "googlemail.com": true };

/**
 * Lowercase and trim an email.
 * @param {*} raw - Anything.
 * @returns {string}
 */
function normalizeEmail(raw) {
  return String(raw === undefined || raw === null ? "" : raw)
    .trim()
    .toLowerCase();
}

/**
 * The key two spellings of one mailbox share. Gmail ignores dots and
 * "+anything" in the local part and treats googlemail.com as gmail.com, so
 * "Jane.Doe+hack@gmail.com" and "janedoe@googlemail.com" are one person.
 * Other providers are only lowercased (their rules differ).
 * @param {string} email - An email address.
 * @returns {string}
 */
function matchKey(email) {
  var normalized = normalizeEmail(email);
  var at = normalized.lastIndexOf("@");
  if (at < 1) {
    return normalized;
  }
  var local = normalized.slice(0, at);
  var domain = normalized.slice(at + 1);
  if (GMAIL_DOMAINS[domain]) {
    local = local.split("+")[0].replace(/\./g, "");
    domain = "gmail.com";
  }
  return local + "@" + domain;
}

/**
 * Every valid email in a piece of text, lowercased, in order, without repeats.
 * @param {*} text - Free text.
 * @returns {Array<string>}
 */
function extractEmails(text) {
  var found = String(text || "").match(EMAIL_PATTERN) || [];
  var seen = {};
  var out = [];
  found.forEach(function each(raw) {
    var email = normalizeEmail(raw).replace(/^[.'_%+-]+/, "").replace(/\.+$/, "");
    if (!validator.isEmail(email) || seen[email]) {
      return;
    }
    seen[email] = true;
    out.push(email);
  });
  return out;
}

/**
 * Strip the punctuation and filler around a name ("- ", ":", "...", quotes).
 * @param {string} text - A fragment of an answer.
 * @returns {string}
 */
function cleanName(text) {
  return String(text || "")
    .replace(/\b(?:e-?mail|name)\s*:/gi, " ")
    .replace(/^[\s\-–—:<>"'`.*•~=_]+|[\s\-–—:<>"'`.*•~=_?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a fragment reads like a person's name rather than a sentence:
 * one to five words of letters, at least one with two or more letters, and
 * none of the filler words.
 * @param {string} text - A cleaned fragment.
 * @returns {boolean}
 */
function looksLikeName(text) {
  var name = cleanName(text);
  if (name.length < 2 || name.length > 60) {
    return false;
  }
  if (!/^\p{L}[\p{L}\p{M}'’.\- ]*$/u.test(name)) {
    return false;
  }
  var words = name.split(" ");
  if (words.length > 5) {
    return false;
  }
  var longWord = words.some(function isLong(word) {
    return word.replace(/[^\p{L}]/gu, "").length >= 2;
  });
  if (!longWord) {
    return false;
  }
  return !words.some(function isNoise(word) {
    return NOISE[word.toLowerCase().replace(/[.’']+$/, "")];
  });
}

/**
 * Read one teammates answer.
 *
 *   "Aarnav khanna - a@x.edu, Aryaman Goenka - b@x.edu"  -> two emails with names
 *   "(Isha Nayar, i@x.edu), (Shamitha, s@x.edu)"         -> names paired with the next email
 *   "Didy, Jeffrey, Michael"                             -> three names, no emails
 *   "forming" / "but we might need more people?"         -> ignored
 *
 * @param {*} text - The answer.
 * @returns {{emails: Array<{email: string, name: string}>, names: Array<string>, raw: string}}
 *   `names` are names written without an email.
 */
function parseTeammates(text) {
  var raw = Array.isArray(text) ? text.join(", ") : String(text === undefined || text === null ? "" : text);
  var emails = [];
  var names = [];
  var seen = {};
  var pendingName = "";

  function addEmail(email, name) {
    if (seen[email]) {
      if (name && !seen[email].name) {
        seen[email].name = name;
      }
      return;
    }
    seen[email] = { email: email, name: name || "" };
    emails.push(seen[email]);
  }

  function flushPending() {
    if (pendingName) {
      names.push(pendingName);
      pendingName = "";
    }
  }

  raw.split(SEGMENT_SPLIT).forEach(function eachSegment(segment) {
    var part = String(segment || "");
    var found = extractEmails(part);
    if (!found.length) {
      if (looksLikeName(part)) {
        flushPending();
        pendingName = cleanName(part);
      }
      return;
    }
    // Text between emails names the email after it; text after the last one
    // names it when nothing came before ("i@x.edu Isha Nayar").
    var rest = part;
    found.forEach(function eachEmail(email, index) {
      var position = rest.toLowerCase().indexOf(email);
      var before = position >= 0 ? rest.slice(0, position) : "";
      rest = position >= 0 ? rest.slice(position + email.length) : rest;
      var name = looksLikeName(before) ? cleanName(before) : "";
      if (!name && index === 0 && pendingName) {
        name = pendingName;
        pendingName = "";
      }
      if (!name && index === found.length - 1 && looksLikeName(rest)) {
        name = cleanName(rest);
      }
      addEmail(email, name);
    });
    flushPending();
  });
  flushPending();

  var unique = [];
  names.forEach(function dedupe(name) {
    if (unique.indexOf(name) === -1) {
      unique.push(name);
    }
  });
  return { emails: emails, names: unique, raw: raw.trim() };
}

/**
 * A comparable form of a person's name: lowercased, accents and punctuation
 * dropped, spaces collapsed.
 * @param {string} name - A name.
 * @returns {string}
 */
function nameKey(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find a question on a round's form: by key first, then by its label.
 * @param {Array<object>} formConfig - The round's questions ({ key, label, type }).
 * @param {object} spec
 * @param {string} spec.key - Preferred key, e.g. "teammates".
 * @param {Array<RegExp>} spec.patterns - Label patterns, most specific first.
 * @param {Array<string>} [spec.types] - Allowed question types for a label match.
 * @returns {object|null} The question.
 */
function findQuestion(formConfig, spec) {
  var fields = Array.isArray(formConfig) ? formConfig : [];
  var byKey = fields.filter(function sameKey(field) {
    return field && field.key === spec.key;
  })[0];
  if (byKey) {
    return byKey;
  }
  for (var i = 0; i < spec.patterns.length; i++) {
    var pattern = spec.patterns[i];
    var match = fields.filter(function byLabel(field) {
      if (!field || (spec.types && spec.types.indexOf(field.type) === -1)) {
        return false;
      }
      return pattern.test(String(field.label || "")) || pattern.test(String(field.key || "").replace(/_/g, " "));
    })[0];
    if (match) {
      return match;
    }
  }
  return null;
}

/**
 * The team-related questions of a form, found by key or label so other
 * events' forms work too.
 * @param {Array<object>} formConfig - The round's questions.
 * @returns {{teammates: object|null, hasTeam: object|null, research: object|null, pairing: object|null, formationEvent: object|null}}
 */
function teamQuestions(formConfig) {
  var choice = ["select", "multiselect", "checkbox"];
  return {
    teammates: findQuestion(formConfig, {
      key: "teammates",
      patterns: [/teammates?'?\s*(names|emails)/i, /list (your|the) team/i, /teammates?|team members/i],
      types: ["text", "textarea"],
    }),
    hasTeam: findQuestion(formConfig, {
      key: "has_team",
      patterns: [/(do|already) (you )?have a team/i, /have a team/i],
      types: choice,
    }),
    research: findQuestion(formConfig, { key: "research_study", patterns: [/research/i], types: choice }),
    pairing: findQuestion(formConfig, {
      key: "team_pairing",
      patterns: [/pair(ed|ing)?\b.*team|team.*pair/i, /match(ed|ing)? (you )?with/i],
      types: choice.concat(["text"]),
    }),
    formationEvent: findQuestion(formConfig, {
      key: "team_formation_event",
      patterns: [/team[-\s]?(formation|building|forming)/i],
      types: choice.concat(["text"]),
    }),
  };
}

/**
 * An answer as one line of text (lists joined, booleans as Yes/No).
 * @param {object} answers - Application.answers.
 * @param {object|null} question - From teamQuestions.
 * @returns {string}
 */
function answerText(answers, question) {
  if (!question || !answers) {
    return "";
  }
  var value = answers[question.key];
  if (value === undefined || value === null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  return String(value).trim();
}

/**
 * A team name made unique against names already taken (by nameKey),
 * with " 2", " 3", ... appended as needed. Adds the result to `taken`.
 * @param {string} base - The wanted name.
 * @param {object} taken - nameKey -> true; updated.
 * @param {function} keyFor - Team.nameKeyFor.
 * @returns {string}
 */
function uniqueTeamName(base, taken, keyFor) {
  var name = String(base || "").trim().replace(/\s+/g, " ").slice(0, 55);
  if (name.length < 2) {
    name = "Team";
  }
  var candidate = name;
  for (var n = 2; taken[keyFor(candidate)]; n++) {
    candidate = name + " " + n;
  }
  taken[keyFor(candidate)] = true;
  return candidate;
}

/**
 * Upper-case the first letter of each word, leaving the rest as written.
 * @param {string} text - A name.
 * @returns {string}
 */
function capitalizeWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(function cap(word) {
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * The default name for a team led by someone: "<First name>'s team".
 * @param {string} fullName - Leader's name.
 * @param {boolean} [withLastName] - Use the whole name ("Ana Lee's team").
 * @returns {string}
 */
function defaultTeamName(fullName, withLastName) {
  var words = capitalizeWords(fullName).split(" ").filter(Boolean);
  var who = withLastName ? words.join(" ") : words[0] || "";
  return who ? who + "'s team" : "Team";
}

/**
 * A free default name for a team: "Ana's team", else "Ana Lee's team", else
 * a number is added. Adds the result to `taken`.
 * @param {string} fullName - Leader's name.
 * @param {object} taken - nameKey -> true; updated.
 * @param {function} keyFor - Team.nameKeyFor.
 * @returns {string}
 */
function proposalTeamName(fullName, taken, keyFor) {
  var short = defaultTeamName(fullName);
  if (!taken[keyFor(short)]) {
    taken[keyFor(short)] = true;
    return short;
  }
  var long = defaultTeamName(fullName, true);
  if (long !== short && !taken[keyFor(long)]) {
    taken[keyFor(long)] = true;
    return long;
  }
  return uniqueTeamName(long, taken, keyFor);
}

/**
 * Group applications into proposed teams.
 *
 * @param {object} input
 * @param {Array<object>} input.applications - The round's submitted
 *   applications: { id, userId, email (account), name, status, createdAt,
 *   teammates (answer text), inScope }.
 * @param {Array<object>} input.users - Accounts that may be listed:
 *   { id, email, name, role }.
 * @param {object} input.teamByUser - userId -> { id, name, locked, size, invites }.
 * @param {object} input.invitesByKey - matchKey -> [{ id, name }] pending invites.
 * @param {number} input.maxSize - Largest team.
 * @param {Array<string>} input.takenNames - nameKeys of existing teams.
 * @param {function} input.nameKeyFor - Team.nameKeyFor.
 * @returns {{proposals: Array<object>, unmatched: Array<object>}}
 *   `unmatched`: in-scope applicants who wrote something but ended up alone.
 */
function buildProposals(input) {
  var nodes = {};
  var edges = {}; // key -> { otherKey: true } (undirected, in-scope listings)
  var listings = {}; // key -> { otherKey: "email" | "name" } (directed, every application)
  var usersByKey = {};
  var teamByUser = input.teamByUser || {};
  var invitesByKey = input.invitesByKey || {};

  (input.users || []).forEach(function indexUser(user) {
    usersByKey[matchKey(user.email)] = user;
  });

  function node(key, literal) {
    if (!nodes[key]) {
      nodes[key] = { key: key, literal: literal, listedAs: "", app: null, unmatchedNames: [], raw: "" };
    }
    return nodes[key];
  }

  function link(from, to, how, inScope) {
    listings[from] = listings[from] || {};
    if (!listings[from][to] || how === "email") {
      listings[from][to] = how;
    }
    if (!inScope) {
      return;
    }
    edges[from] = edges[from] || {};
    edges[to] = edges[to] || {};
    edges[from][to] = true;
    edges[to][from] = true;
  }

  var apps = (input.applications || []).slice().sort(function earliest(a, b) {
    return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
  });

  // Full names of applicants, for answers that only give names.
  var byName = {};
  apps.forEach(function indexName(app) {
    var key = nameKey(app.name);
    if (key.split(" ").length < 2) {
      return;
    }
    byName[key] = byName[key] || {};
    byName[key][matchKey(app.email)] = true;
  });

  apps.forEach(function addApplicant(app) {
    var n = node(matchKey(app.email), normalizeEmail(app.email));
    if (!n.app) {
      n.app = app;
    }
  });

  /**
   * The person a listed email stands for. People often write a teammate's
   * other address (a Gmail instead of the school email they applied with).
   * When that address has no application of its own and the name written
   * next to it matches exactly one applicant, it is that applicant; otherwise
   * two spellings of one teammate would look like a mismatched list.
   * @param {{email: string, name: string}} item - From parseTeammates.
   * @returns {string} Match key.
   */
  function resolveListed(item) {
    var key = matchKey(item.email);
    if ((nodes[key] && nodes[key].app) || !item.name) {
      return key;
    }
    var matches = Object.keys(byName[nameKey(item.name)] || {});
    return matches.length === 1 ? matches[0] : key;
  }

  apps.forEach(function addListings(app) {
    var self = matchKey(app.email);
    var parsed = parseTeammates(app.teammates);
    var me = nodes[self];
    if (app.inScope) {
      me.raw = parsed.raw;
    }
    parsed.emails.forEach(function eachEmail(item) {
      var key = resolveListed(item);
      if (key === self) {
        return;
      }
      var other = node(key, item.email);
      if (item.name && !other.listedAs) {
        other.listedAs = item.name;
      }
      link(self, key, "email", app.inScope);
    });
    parsed.names.forEach(function eachName(name) {
      var matches = Object.keys(byName[nameKey(name)] || {}).filter(function notSelf(key) {
        return key !== self;
      });
      if (matches.length === 1) {
        link(self, matches[0], "name", app.inScope);
      } else if (app.inScope) {
        me.unmatchedNames.push(name);
      }
    });
  });

  // Connected components over the in-scope listings.
  var visited = {};
  var components = [];
  Object.keys(nodes).forEach(function start(key) {
    if (visited[key] || !edges[key]) {
      return;
    }
    var stack = [key];
    var members = [];
    visited[key] = true;
    while (stack.length) {
      var current = stack.pop();
      members.push(current);
      Object.keys(edges[current] || {}).forEach(function neighbour(next) {
        if (!visited[next]) {
          visited[next] = true;
          stack.push(next);
        }
      });
    }
    components.push(members);
  });

  var taken = {};
  (input.takenNames || []).forEach(function markTaken(key) {
    taken[key] = true;
  });
  var keyFor = input.nameKeyFor || nameKey;

  var proposals = components.map(function toProposal(keys) {
    return describeComponent(keys, {
      nodes: nodes,
      listings: listings,
      usersByKey: usersByKey,
      teamByUser: teamByUser,
      invitesByKey: invitesByKey,
      maxSize: input.maxSize,
    });
  });

  proposals.sort(function byLeaderTime(a, b) {
    return a.order - b.order;
  });
  proposals.forEach(function nameIt(proposal) {
    proposal.defaultName = proposal.status === "conflict" ? "" : proposalTeamName(proposal.leaderName, taken, keyFor);
    delete proposal.order;
    delete proposal.leaderName;
  });

  var unmatched = [];
  apps.forEach(function alone(app) {
    var n = nodes[matchKey(app.email)];
    if (!app.inScope || visited[n.key] || !n.raw) {
      return;
    }
    unmatched.push({
      applicationId: app.id,
      name: app.name,
      email: normalizeEmail(app.email),
      status: app.status,
      raw: n.raw,
      names: n.unmatchedNames,
      team: app.userId && teamByUser[String(app.userId)] ? publicTeam(teamByUser[String(app.userId)]) : null,
    });
  });

  return { proposals: proposals, unmatched: unmatched };
}

/**
 * @param {object} team - From teamByUser.
 * @returns {{id: string, name: string, locked: boolean, size: number, invites: number}}
 */
function publicTeam(team) {
  return { id: String(team.id), name: team.name, locked: Boolean(team.locked), size: team.size || 0, invites: team.invites || 0 };
}

/**
 * One proposal: its members with what is known about each, and the flags
 * staff should look at.
 * @param {Array<string>} keys - Match keys in the component.
 * @param {object} ctx - Indexes built by buildProposals.
 * @returns {object}
 */
function describeComponent(keys, ctx) {
  var members = keys.map(function toMember(key) {
    var n = ctx.nodes[key];
    var user = ctx.usersByKey[key] || null;
    var app = n.app;
    var userId = user ? String(user.id) : app && app.userId ? String(app.userId) : null;
    var team = userId && ctx.teamByUser[userId] ? publicTeam(ctx.teamByUser[userId]) : null;
    return {
      key: key,
      email: user ? normalizeEmail(user.email) : app ? normalizeEmail(app.email) : n.literal,
      listedEmail: n.literal,
      name: (app && app.name) || (user && user.name) || n.listedAs || "",
      listedAs: n.listedAs,
      userId: userId,
      hasAccount: Boolean(user || (app && app.userId)),
      role: user ? user.role : "applicant",
      applicationId: app ? String(app.id) : null,
      status: app ? app.status : null,
      inScope: Boolean(app && app.inScope),
      appliedAt: app ? app.createdAt : null,
      team: team,
      invitedTo: (ctx.invitesByKey[key] || []).map(function toTeam(t) {
        return { id: String(t.id), name: t.name };
      }),
      lists: [],
      listedBy: [],
      unmatchedNames: n.unmatchedNames.slice(),
      raw: n.raw,
    };
  });

  var byKey = {};
  members.forEach(function index(m) {
    byKey[m.key] = m;
  });

  var mutual = 0;
  var oneSided = 0;
  var byNameLinks = 0;
  var counted = {};
  members.forEach(function links(m) {
    Object.keys(ctx.listings[m.key] || {}).forEach(function eachListed(other) {
      if (!byKey[other]) {
        return;
      }
      m.lists.push(byKey[other].email);
      byKey[other].listedBy.push(m.email);
      if (ctx.listings[m.key][other] === "name") {
        byNameLinks += 1;
      }
      var pair = [m.key, other].sort().join(" ");
      if (counted[pair]) {
        return;
      }
      counted[pair] = true;
      var back = ctx.listings[other] && ctx.listings[other][m.key];
      if (back) {
        mutual += 1;
      } else if (byKey[other].status) {
        oneSided += 1;
      }
    });
  });

  // Applicants first, earliest application first; then listed emails.
  members.sort(function order(a, b) {
    if (Boolean(a.appliedAt) !== Boolean(b.appliedAt)) {
      return a.appliedAt ? -1 : 1;
    }
    if (a.appliedAt && b.appliedAt) {
      return new Date(a.appliedAt).getTime() - new Date(b.appliedAt).getTime();
    }
    return a.email < b.email ? -1 : 1;
  });

  var group = analyseGroup(keys, members, byKey, ctx);
  var leader = pickLeader(members, null);
  var teams = {};
  members.forEach(function collect(m) {
    if (m.team) {
      teams[m.team.id] = m.team;
    }
  });
  var existingTeams = Object.keys(teams).map(function toTeam(id) {
    return teams[id];
  });
  var openTeams = existingTeams.filter(function open(t) {
    return !t.locked;
  });

  var eligible = members.filter(isEligible);
  var settled = eligible.filter(function done(m) {
    return m.team || m.invitedTo.length;
  });

  var isDone = eligible.length > 0 && settled.length === eligible.length;
  var unmatchedNames = members
    .filter(function hasNames(m) {
      return m.unmatchedNames.length;
    })
    .map(function toNote(m) {
      return { email: m.email, name: m.name, names: m.unmatchedNames, raw: m.raw };
    });

  var ids = keys.slice().sort();
  return {
    id: shortHash(ids.join(",")),
    members: members.map(function strip(m) {
      var out = Object.assign({}, m);
      delete out.key;
      delete out.raw;
      delete out.unmatchedNames;
      return out;
    }),
    leaderEmail: leader ? leader.email : members[0].email,
    leaderName: leader ? leader.name : members[0].name,
    existingTeams: existingTeams,
    suggestedMergeTeamId: existingTeams.length === 1 && openTeams.length === 1 ? openTeams[0].id : null,
    links: { mutual: mutual, oneSided: oneSided, unconfirmed: countUnconfirmed(members), byName: byNameLinks },
    flags: {
      overMax: members.length > ctx.maxSize,
      differentTeams: existingTeams.length > 1,
      lockedTeam: existingTeams.some(function locked(t) {
        return t.locked;
      }),
      noApplication: members
        .filter(function noApp(m) {
          return !m.status;
        })
        .map(function email(m) {
          return m.email;
        }),
      noAccount: members
        .filter(function noAccount(m) {
          return !m.hasAccount;
        })
        .map(function email(m) {
          return m.email;
        }),
      notInScope: members
        .filter(function outside(m) {
          return m.status && !m.inScope;
        })
        .map(function email(m) {
          return m.email;
        }),
      unmatchedNames: unmatchedNames,
    },
    done: isDone,
    status: isDone ? "done" : group.conflict ? "conflict" : "ready",
    conflict: group.conflict,
    order: leader && leader.appliedAt ? new Date(leader.appliedAt).getTime() : Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Whether a group's listers agree. Each lister claims T = themselves plus
 * everyone they listed (by match key). People who listed nobody, rejected
 * applicants, and listed people with no application are silent and agree by
 * default. Marks each member's `isLister`.
 *
 * @param {Array<string>} keys - Match keys in the group.
 * @param {Array<object>} members - The group's members (sorted, with `key`).
 * @param {object} byKey - key -> member.
 * @param {object} ctx - Indexes built by buildProposals.
 * @returns {{conflict: (object|null)}} `conflict`: { reason: "mismatch" |
 *   "too_many", size, maxSize, signature, listers: [{ email, name, userId,
 *   inScope, status, role, team, setKey, list: [{ email, name }] }] }.
 */
function analyseGroup(keys, members, byKey, ctx) {
  function person(key) {
    var n = ctx.nodes[key];
    var user = ctx.usersByKey[key];
    var app = n.app;
    return {
      email: user ? normalizeEmail(user.email) : app ? normalizeEmail(app.email) : n.literal,
      name: (app && app.name) || (user && user.name) || n.listedAs || "",
    };
  }

  var listers = [];
  members.forEach(function find(m) {
    var n = ctx.nodes[m.key];
    var listed = Object.keys(ctx.listings[m.key] || {}).filter(function other(k) {
      return k !== m.key;
    });
    if (!n.app || n.app.status === "rejected" || !listed.length) {
      return;
    }
    m.isLister = true;
    listers.push({
      email: m.email,
      name: m.name,
      userId: m.userId,
      inScope: m.inScope,
      status: m.status,
      role: m.role,
      team: m.team,
      setKey: [m.key].concat(listed).sort().join(" "),
      list: listed.map(person),
    });
  });
  members.forEach(function mark(m) {
    m.isLister = Boolean(m.isLister);
  });

  var distinct = {};
  listers.forEach(function add(l) {
    distinct[l.setKey] = true;
  });
  var differs = Object.keys(distinct).length > 1;
  var tooMany = !differs && listers.length > 0 && members.length > ctx.maxSize;
  if (!differs && !tooMany) {
    return { conflict: null };
  }
  return {
    conflict: {
      reason: differs ? "mismatch" : "too_many",
      size: members.length,
      maxSize: ctx.maxSize,
      signature: shortHash(
        listers
          .map(function sig(l) {
            return l.setKey;
          })
          .sort()
          .join("|")
      ),
      listers: listers,
    },
  };
}

/**
 * The plain-text explanation emailed to one lister in a conflict.
 * @param {object} conflict - proposal.conflict.
 * @param {string} email - The recipient lister's email.
 * @returns {string}
 */
function conflictDetails(conflict, email) {
  // A name written with two different addresses is shown with the address,
  // otherwise the lists can read as identical while they differ.
  var emailsByName = {};
  conflict.listers.forEach(function eachLister(l) {
    [{ name: l.name, email: l.email }].concat(l.list).forEach(function eachPerson(p) {
      if (p.name) {
        emailsByName[p.name] = emailsByName[p.name] || {};
        emailsByName[p.name][p.email] = true;
      }
    });
  });
  function label(p) {
    if (!p.name) {
      return p.email;
    }
    return Object.keys(emailsByName[p.name]).length > 1 ? p.name + " (" + p.email + ")" : p.name;
  }
  function join(items) {
    if (items.length < 2) {
      return items.join("");
    }
    return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
  }
  var me = conflict.listers.filter(function same(l) {
    return l.email === email;
  })[0];
  if (!me) {
    return "";
  }
  if (conflict.reason === "too_many") {
    return (
      "The team you listed has " + conflict.size + " people, but a team can have at most " + conflict.maxSize +
      ". You listed: " + join(me.list.map(label)) + "."
    );
  }
  var others = conflict.listers.filter(function differ(l) {
    return l.setKey !== me.setKey;
  });
  var lines = [
    "Your teammate list doesn't match " + join(others.map(function who(l) {
      return label(l) + "'s";
    })).replace(/'s and /g, " and ") + " list.",
    "You listed: " + join(me.list.map(label)) + ".",
  ];
  others.forEach(function theirs(l) {
    lines.push(label(l) + " listed: " + join(l.list.map(label)) + ".");
  });
  return lines.join("\n");
}

/**
 * Listed people with no application, who therefore can't confirm the link.
 * @param {Array<object>} members - Proposal members.
 * @returns {number}
 */
function countUnconfirmed(members) {
  return members.filter(function noApp(m) {
    return !m.status;
  }).length;
}

/**
 * Whether builder actions may touch this person: not a rejected applicant and
 * not staff-only accounts (judges).
 * @param {object} member - A proposal member.
 * @returns {boolean}
 */
function isEligible(member) {
  return member.status !== "rejected" && member.role !== "judge";
}

/**
 * Who should lead a new team: the requested person when they can (an
 * eligible account on no team), else the earliest in-scope applicant who can.
 * @param {Array<object>} members - Members in leader-preference order.
 * @param {string|null} wanted - Requested leader email.
 * @param {boolean} [onlyWanted] - Only the requested person; null otherwise.
 * @returns {object|null}
 */
function pickLeader(members, wanted, onlyWanted) {
  function canLead(m) {
    return isEligible(m) && m.hasAccount && m.userId && !m.team;
  }
  var key = wanted ? matchKey(wanted) : "";
  var asked = members.filter(function same(m) {
    return key && (matchKey(m.email) === key || matchKey(m.listedEmail || "") === key);
  })[0];
  if (asked && canLead(asked)) {
    return asked;
  }
  if (onlyWanted) {
    return null;
  }
  return (
    members.filter(function lister(m) {
      return m.inScope && m.isLister && canLead(m);
    })[0] ||
    members.filter(function inScope(m) {
      return m.inScope && canLead(m);
    })[0] ||
    members.filter(canLead)[0] ||
    null
  );
}

/**
 * A short stable id for a set of keys (FNV-1a, hex).
 * @param {string} text - Input.
 * @returns {string}
 */
function shortHash(text) {
  var hash = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ("0000000" + hash.toString(16)).slice(-8) + text.length.toString(16);
}

/**
 * Decide what applying one proposal does, from fresh state. Nothing here
 * trusts the client: `memberEmails` may only narrow a proposal the server
 * built itself, the leader must be able to lead, and a merge target must be a
 * team one of the members is already on.
 *
 * @param {object} proposal - A server-built proposal (members carry fresh
 *   `team` and `invitedTo`).
 * @param {object} request - { memberEmails, name, leaderEmail, mergeIntoTeamId }.
 * @param {object} ctx
 * @param {number} ctx.maxSize - Largest team.
 * @param {object} [ctx.mergeTeam] - Fresh { id, name, locked, size, invites,
 *   leaderId } of the merge target.
 * @returns {object} { action: "create"|"merge"|"skip", reason?, leader?,
 *   name?, teamId?, add: [member], invite: [member], skipped: [{email, reason}] }
 */
function planApply(proposal, request, ctx) {
  var wanted = {};
  (request.memberEmails || []).forEach(function mark(email) {
    wanted[matchKey(email)] = true;
  });
  var members = proposal.members.filter(function chosen(m) {
    return wanted[matchKey(m.email)] || wanted[matchKey(m.listedEmail || "")];
  });
  var plan = { action: "skip", add: [], invite: [], skipped: [] };
  if (proposal.status === "conflict") {
    plan.reason = "The lists don't match, so no team is created. Resolve it manually.";
    return plan;
  }
  if (members.length < 2) {
    plan.reason = "Pick at least two people for a team.";
    return plan;
  }

  var merge = request.mergeIntoTeamId ? String(request.mergeIntoTeamId) : "";
  var capacity;
  var leader = null;
  if (merge) {
    var target = ctx.mergeTeam;
    var onTarget = members.some(function isOn(m) {
      return m.team && m.team.id === merge;
    });
    if (!target || !onTarget) {
      plan.reason = "That team isn't one of these people's teams.";
      return plan;
    }
    if (target.locked) {
      plan.reason = "\"" + target.name + "\" is checked in for judging, so it is locked.";
      return plan;
    }
    plan.action = "merge";
    plan.teamId = merge;
    plan.name = target.name;
    capacity = ctx.maxSize - (target.size || 0) - (target.invites || 0);
  } else {
    // An imported team is only started by the person the import names, so
    // running the same import again doesn't start a second team.
    leader = request.inviteOnly ? pickLeader(members, request.leaderEmail, true) : pickLeader(members, request.leaderEmail);
    if (!leader) {
      plan.reason = "No one here can lead a new team: everyone is already on a team or has no account.";
      return plan;
    }
    plan.action = "create";
    plan.leader = leader;
    plan.name = String(request.name || "").trim().replace(/\s+/g, " ");
    capacity = ctx.maxSize - 1;
  }

  members.forEach(function decide(m) {
    if ((leader && m === leader) || (merge && m.team && m.team.id === merge)) {
      return;
    }
    var skip = skipReason(m, merge);
    if (skip) {
      plan.skipped.push({ email: m.email, name: m.name, reason: skip });
      return;
    }
    if (capacity <= 0) {
      plan.skipped.push({ email: m.email, name: m.name, reason: "The team is full (" + ctx.maxSize + " people, counting invites)." });
      return;
    }
    capacity -= 1;
    // Imported (suggested) teams only invite: people choose to accept.
    if (plan.action === "create" && !request.inviteOnly && m.hasAccount && m.userId) {
      plan.add.push(m);
    } else {
      plan.invite.push(m);
    }
  });

  if (plan.action === "create" && !plan.add.length && !plan.invite.length) {
    plan.action = "skip";
    plan.reason = "Everyone else is already on a team or invited, so there is no one to team up with.";
    delete plan.leader;
  }
  if (plan.action === "merge" && !plan.invite.length) {
    plan.action = "skip";
    plan.reason = "Everyone is already on \"" + plan.name + "\" or invited to it.";
  }
  return plan;
}

/**
 * Why a member is left alone, or "" when they can be added or invited.
 * @param {object} m - A proposal member (fresh state).
 * @param {string} mergeTeamId - The merge target, or "".
 * @returns {string}
 */
function skipReason(m, mergeTeamId) {
  if (m.status === "rejected") {
    return "Their application was rejected.";
  }
  if (m.role === "judge") {
    return "Judges can't join teams.";
  }
  if (m.team && m.team.id !== mergeTeamId) {
    return "Already on \"" + m.team.name + "\".";
  }
  if (m.invitedTo.length) {
    return "Already invited to \"" + m.invitedTo[0].name + "\".";
  }
  return "";
}

module.exports = {
  normalizeEmail: normalizeEmail,
  matchKey: matchKey,
  extractEmails: extractEmails,
  looksLikeName: looksLikeName,
  parseTeammates: parseTeammates,
  nameKey: nameKey,
  findQuestion: findQuestion,
  teamQuestions: teamQuestions,
  answerText: answerText,
  uniqueTeamName: uniqueTeamName,
  defaultTeamName: defaultTeamName,
  proposalTeamName: proposalTeamName,
  conflictDetails: conflictDetails,
  buildProposals: buildProposals,
  pickLeader: pickLeader,
  planApply: planApply,
  isEligible: isEligible,
};
