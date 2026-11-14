"use strict";

var validator = require("validator");

var OrgSettings = require("../schemas/orgSettings");
var Team = require("../schemas/team");
var TeamSuggestion = require("../schemas/teamSuggestion");
var User = require("../schemas/user");
var mailer = require("../utils/mailer");
var outbox = require("../utils/outbox");
var primaryClientOrigin = require("../utils/clientOrigin").primaryClientOrigin;
var teamProposals = require("../utils/teamProposals");

// Suggested teams (Teams page -> Import suggested teams). An import creates a
// TeamSuggestion per team and emails every member; nobody is put on a team.
// Accepting and declining are in teamController (the participant's side).

var MAX_TEAMS = 1000;
var BODY_FIELDS = ["teams", "dryRun", "allowOverLimit"];
var STAFF_ROLES = ["admin", "moderator"];

/**
 * Validate { teams: [{ emails: [...] }] }.
 * @param {*} list - body.teams.
 * @param {number} maxSize - Largest team.
 * @returns {{teams: (Array<Array<string>>|undefined), error: (string|undefined)}}
 */
function readTeams(list, maxSize) {
  if (!Array.isArray(list) || !list.length) {
    return { error: "Send teams: a list of { emails }." };
  }
  if (list.length > MAX_TEAMS) {
    return { error: "At most " + MAX_TEAMS + " teams per import." };
  }
  var seen = {};
  var teams = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item || typeof item !== "object" || !Array.isArray(item.emails)) {
      return { error: "Team " + (i + 1) + " needs emails (a list)." };
    }
    var emails = [];
    for (var j = 0; j < item.emails.length; j++) {
      var email = typeof item.emails[j] === "string" ? teamProposals.normalizeEmail(item.emails[j]) : "";
      if (!email || !validator.isEmail(email)) {
        return { error: "Team " + (i + 1) + " has an invalid email: " + String(item.emails[j]) + "." };
      }
      if (seen[email]) {
        return { error: email + " is in more than one team (teams " + seen[email] + " and " + (i + 1) + ")." };
      }
      seen[email] = i + 1;
      emails.push(email);
    }
    if (emails.length < 2 || emails.length > maxSize) {
      return { error: "Team " + (i + 1) + " has " + emails.length + " people; teams are 2 to " + maxSize + "." };
    }
    teams.push(emails);
  }
  return { teams: teams };
}

/**
 * "A, B and C".
 * @param {Array<string>} items - Names.
 * @returns {string}
 */
function joinNames(items) {
  if (items.length < 2) {
    return items.join("");
  }
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

/**
 * Who can't be suggested and why, by email.
 * @param {Array<string>} emails - Everyone in the import.
 * @returns {Promise<{users: object, reasons: object}>} users: email -> user.
 */
async function lookUp(emails) {
  var users = {};
  (await User.find({ email: { $in: emails } }).select("name email role").lean()).forEach(function index(u) {
    users[u.email] = u;
  });
  var ids = Object.keys(users).map(function id(email) {
    return users[email]._id;
  });
  var teamOf = {};
  (await Team.find({ members: { $in: ids } }).select("name members").lean()).forEach(function index(t) {
    t.members.forEach(function each(id) {
      teamOf[String(id)] = t.name;
    });
  });
  var suggested = {};
  (
    await TeamSuggestion.find({ "members.email": { $in: emails } })
      .select("members")
      .lean()
  ).forEach(function index(s) {
    s.members.forEach(function each(m) {
      if (m.status !== "declined") {
        suggested[m.email] = true;
      }
    });
  });
  var reasons = {};
  emails.forEach(function why(email) {
    var u = users[email];
    if (u && STAFF_ROLES.indexOf(u.role) !== -1) {
      reasons[email] = "Staff account.";
    } else if (u && u.role === "judge") {
      reasons[email] = "Judges can't join teams.";
    } else if (u && teamOf[String(u._id)]) {
      reasons[email] = "Already on \"" + teamOf[String(u._id)] + "\".";
    } else if (suggested[email]) {
      reasons[email] = "Already has a suggested team.";
    }
  });
  return { users: users, reasons: reasons };
}

/**
 * POST /api/admin/team-builder/suggest
 * Body: { teams: [{ emails }], dryRun?, allowOverLimit? }
 *
 * Suggest teams: each team becomes a TeamSuggestion and every member gets the
 * `team_suggestion` email. Nobody is put on a team; the first to accept starts
 * it. People who are staff, judges, on a team or already suggested are left
 * out, so importing the same file again sends nothing new. With `dryRun` it
 * only reports.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function importSuggestions(req, res) {
  try {
    var body = req.body || {};
    var unknown = Object.keys(body).filter(function isUnknown(key) {
      return BODY_FIELDS.indexOf(key) === -1;
    });
    if (unknown.length) {
      res.status(400).json({ error: "Unknown field: " + unknown.join(", ") + "." });
      return;
    }
    var settings = await OrgSettings.getSingleton();
    var parsed = readTeams(body.teams, settings.teamMaxSize || 4);
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    var all = [].concat.apply([], parsed.teams);
    var found = await lookUp(all);

    var results = parsed.teams.map(function plan(emails) {
      var skipped = [];
      var members = [];
      emails.forEach(function each(email) {
        if (found.reasons[email]) {
          skipped.push({ email: email, reason: found.reasons[email] });
        } else {
          var u = found.users[email];
          members.push({ email: email, user: u ? u._id : null, name: u ? u.name : "" });
        }
      });
      if (members.length < 2) {
        return { action: "skipped", reason: "Fewer than two people left to suggest.", members: members, skipped: skipped };
      }
      return { action: "suggested", reason: "", members: members, skipped: skipped };
    });
    var totals = { suggested: 0, people: 0, skippedTeams: 0, skippedPeople: 0 };
    results.forEach(function add(r) {
      totals.skippedPeople += r.skipped.length;
      if (r.action === "suggested") {
        totals.suggested += 1;
        totals.people += r.members.length;
      } else {
        totals.skippedTeams += 1;
      }
    });
    var configured = mailer.isMailConfigured();
    var limit = outbox.dailyLimit();
    var committed = await outbox.committedInLastDay();
    var overLimit = configured && limit > 0 && committed + totals.people > limit;
    var quota = { dailyLimit: limit, committedLast24h: committed, overLimit: overLimit, emailConfigured: configured };
    var view = results.map(function toView(r) {
      return {
        action: r.action,
        reason: r.reason,
        members: r.members.map(function e(m) {
          return m.email;
        }),
        skipped: r.skipped,
      };
    });

    if (body.dryRun === true) {
      res.status(200).json(Object.assign({ dryRun: true, totals: totals, results: view }, quota));
      return;
    }
    if (overLimit && body.allowOverLimit !== true) {
      res.status(409).json(
        Object.assign(
          {
            error:
              "These emails would put you over the sending limit (" + limit + " per 24 hours): " + committed +
              " already sent or waiting plus " + totals.people + " new. Import fewer teams or wait.",
            code: "OVER_DAILY_LIMIT",
          },
          quota
        )
      );
      return;
    }

    var chosen = results.filter(function ok(r) {
      return r.action === "suggested";
    });
    var docs = await TeamSuggestion.insertMany(
      chosen.map(function toDoc(r) {
        return { members: r.members, createdBy: req.user.id };
      })
    );
    var queued = 0;
    if (configured && docs.length) {
      var teamsUrl = primaryClientOrigin() + "/dashboard/team";
      var entries = [];
      docs.forEach(function eachDoc(doc) {
        var names = doc.members.map(function label(m) {
          return m.name || m.email;
        });
        doc.members.forEach(function eachMember(m) {
          entries.push({
            to: m.email,
            user: m.user || undefined,
            templateKey: "team_suggestion",
            category: "transactional",
            values: { name: m.name || "there", memberNames: joinNames(names), teamsUrl: teamsUrl },
          });
        });
      });
      queued = await outbox.enqueueMany(entries, {
        batchId: "team_suggestion:" + Date.now(),
        segment: "team_suggestion",
        requestedBy: req.user.id,
      });
    }
    res.status(200).json(Object.assign({ dryRun: false, totals: totals, results: view, queued: queued }, quota));
  } catch (err) {
    console.error("importSuggestions failed:", err);
    res.status(500).json({ error: "Couldn't import the suggested teams. Try again." });
  }
}

module.exports = {
  importSuggestions: importSuggestions,
  joinNames: joinNames,
};
