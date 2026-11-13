"use strict";

var mongoose = require("mongoose");

var Application = require("../schemas/application");
var activeApplications = require("../utils/activeApplications");
var ApplicationRound = require("../schemas/applicationRound");
var OrgSettings = require("../schemas/orgSettings");
var validator = require("validator");
var Team = require("../schemas/team");
var TeamBuilderRun = require("../schemas/teamBuilderRun");
var TeamConflictNotice = require("../schemas/teamConflictNotice");
var User = require("../schemas/user");
var csv = require("../utils/csv");
var hardwareTeamChange = require("../utils/hardwareTeamChange");
var control = require("../utils/judging/state");
var mailer = require("../utils/mailer");
var outbox = require("../utils/outbox");
var primaryClientOrigin = require("../utils/clientOrigin").primaryClientOrigin;
var teamProposals = require("../utils/teamProposals");
var userGroups = require("../utils/userGroups");

// Admin team builder (mounted at /api/admin/team-builder behind isAdmin).
// Proposes teams from what applicants wrote in the "list your teammates"
// question (utils/teamProposals does the parsing and grouping), creates them
// with the existing invite mechanics, and lists the accepted people left
// without a team (the research-study pool).

var SCOPE_STATUSES = ["accepted", "pending", "waitlisted", "rejected"];
var MAX_PROPOSALS_PER_RUN = 500;
var MAX_MEMBERS_PER_PROPOSAL = 30;
var DUPLICATE_KEY = 11000;
var NO_ANSWER = "__none__";

/**
 * Read `statuses` (comma separated, or repeated) from a query or body.
 * @param {*} raw - The value.
 * @returns {{statuses: Array<string>}|{error: string}}
 */
function readStatuses(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { statuses: ["accepted"] };
  }
  var list = Array.isArray(raw) ? raw : String(raw).split(",");
  var statuses = [];
  for (var i = 0; i < list.length; i++) {
    var status = String(list[i]).trim();
    if (!status) {
      continue;
    }
    if (SCOPE_STATUSES.indexOf(status) === -1) {
      return { error: "statuses must be some of: " + SCOPE_STATUSES.join(", ") + "." };
    }
    if (statuses.indexOf(status) === -1) {
      statuses.push(status);
    }
  }
  return statuses.length ? { statuses: statuses } : { statuses: ["accepted"] };
}

/**
 * Pick the round a request is about (the newest open one by default).
 * @param {*} roundParam - `round` from the query or body.
 * @returns {Promise<{round: object|null, rounds: Array<object>}|{error: string, status: number}>}
 */
function loadRound(roundParam) {
  var param = userGroups.readRoundParam({ round: roundParam });
  if (param.error) {
    return Promise.resolve({ error: param.error, status: 400 });
  }
  return ApplicationRound.find({})
    .select("name isOpen formConfig createdAt order")
    .sort({ order: 1, createdAt: 1 })
    .lean()
    .then(function pick(rounds) {
      if (!param.round) {
        return { round: userGroups.defaultRound(rounds), rounds: rounds };
      }
      var round = rounds.filter(function isRound(r) {
        return String(r._id) === param.round;
      })[0];
      return round ? { round: round, rounds: rounds } : { error: "Round not found.", status: 404 };
    });
}

/**
 * Index teams: who is on which, who is invited where, which names are taken.
 * @param {Array<object>} teams - Lean Team documents.
 * @returns {{teamByUser: object, invitesByKey: object, takenNames: Array<string>, byId: object}}
 */
function indexTeams(teams) {
  var teamByUser = {};
  var invitesByKey = {};
  var byId = {};
  var takenNames = [];
  teams.forEach(function each(team) {
    var summary = {
      id: String(team._id),
      name: team.name,
      locked: Boolean(team.lockedAt),
      size: (team.members || []).length,
      invites: (team.invites || []).length,
      leaderId: team.leader ? String(team.leader) : null,
    };
    byId[summary.id] = summary;
    takenNames.push(team.nameKey);
    (team.members || []).forEach(function onTeam(userId) {
      teamByUser[String(userId)] = summary;
    });
    (team.invites || []).forEach(function invited(invite) {
      var key = teamProposals.matchKey(invite.email);
      invitesByKey[key] = invitesByKey[key] || [];
      invitesByKey[key].push(summary);
    });
  });
  return { teamByUser: teamByUser, invitesByKey: invitesByKey, takenNames: takenNames, byId: byId };
}

/**
 * Validate imported (suggested) teams: { imported: [{ emails: [...] }] }.
 * @param {*} list - body.imported.
 * @param {number} maxSize - Largest team.
 * @returns {{teams: (Array<Array<string>>|undefined), error: (string|undefined)}}
 */
function readImported(list, maxSize) {
  if (!Array.isArray(list) || !list.length) {
    return { error: "Send imported: a list of { emails } teams." };
  }
  if (list.length > MAX_PROPOSALS_PER_RUN) {
    return { error: "At most " + MAX_PROPOSALS_PER_RUN + " teams per import." };
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
      var key = teamProposals.matchKey(email);
      if (seen[key]) {
        return { error: email + " is in more than one team (teams " + seen[key] + " and " + (i + 1) + ")." };
      }
      seen[key] = i + 1;
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
 * Replace everyone's listed teammates with the imported teams, so the
 * proposals are exactly those teams. In each team the first person with an
 * in-scope application leads (lists the rest); everyone else lists nobody
 * and is invited.
 * @param {Array<object>} applications - From loadContext (mutated).
 * @param {Array<Array<string>>} teams - From readImported.
 * @returns {Array<object>} Apply requests, one per team.
 */
function applyImported(applications, teams) {
  var appByKey = {};
  applications.forEach(function index(app) {
    app.teammates = "";
    if (app.inScope) {
      appByKey[teamProposals.matchKey(app.email)] = app;
    }
  });
  return teams.map(function toRequest(emails) {
    var leaderEmail = emails.filter(function hasApp(email) {
      return appByKey[teamProposals.matchKey(email)];
    })[0] || "";
    if (leaderEmail) {
      appByKey[teamProposals.matchKey(leaderEmail)].teammates = emails
        .filter(function others(email) {
          return email !== leaderEmail;
        })
        .join(", ");
    }
    return { memberEmails: emails, name: "", leaderEmail: leaderEmail, mergeIntoTeamId: "", inviteOnly: true };
  });
}

/**
 * Load everything the proposals are built from.
 * @param {object} round - The round (lean, with formConfig).
 * @param {Array<string>} statuses - Statuses in scope.
 * @returns {Promise<object>} { questions, applications, input, teams }
 */
async function loadContext(round, statuses, imported) {
  var questions = teamProposals.teamQuestions(round.formConfig);
  var settings = await OrgSettings.getSingleton();
  var maxSize = settings.teamMaxSize || 4;
  var docs = await Application.find(activeApplications.active({ round: round._id, status: { $ne: "draft" } }))
    .select("applicant name status createdAt answers university major")
    .populate("applicant", "name email role")
    .lean();

  var applications = docs
    .filter(function hasAccount(doc) {
      return doc.applicant && doc.applicant.email;
    })
    .map(function toInput(doc) {
      return {
        id: String(doc._id),
        userId: String(doc.applicant._id),
        email: doc.applicant.email,
        name: doc.name || doc.applicant.name || "",
        status: doc.status,
        createdAt: doc.createdAt,
        teammates: questions.teammates ? teamProposals.answerText(doc.answers, questions.teammates) : "",
        inScope: statuses.indexOf(doc.status) !== -1,
        doc: doc,
      };
    });

  var importedRequests = imported ? applyImported(applications, imported) : null;

  // Accounts for the listed emails. Gmail aliases are compared by match key,
  // so every Gmail account is a candidate.
  var listed = {};
  var gmail = false;
  applications.forEach(function collect(app) {
    teamProposals.extractEmails(app.teammates).forEach(function add(email) {
      listed[email] = true;
      if (/@(gmail|googlemail)\.com$/.test(email)) {
        gmail = true;
      }
    });
  });
  var or = [{ email: { $in: Object.keys(listed) } }];
  if (gmail) {
    or.push({ email: /@(gmail|googlemail)\.com$/ });
  }
  var users = await User.find({ $or: or }).select("name email role").lean();
  applications.forEach(function addApplicants(app) {
    users.push({ _id: app.doc.applicant._id, email: app.email, name: app.doc.applicant.name, role: app.doc.applicant.role });
  });

  var teams = indexTeams(
    await Team.find({}).select("name nameKey leader members invites lockedAt").lean()
  );

  return {
    questions: questions,
    applications: applications,
    importedRequests: importedRequests,
    maxSize: maxSize,
    teams: teams,
    input: {
      applications: applications,
      users: users.map(function toUser(u) {
        return { id: String(u._id), email: u.email, name: u.name, role: u.role };
      }),
      teamByUser: teams.teamByUser,
      invitesByKey: teams.invitesByKey,
      maxSize: maxSize,
      takenNames: teams.takenNames,
      nameKeyFor: Team.nameKeyFor,
    },
  };
}

/**
 * @param {object|null} question - A form question.
 * @returns {object|null} What the UI shows about it.
 */
function questionSummary(question) {
  return question ? { key: question.key, label: question.label || question.key, options: question.options || [] } : null;
}

/**
 * Whether a "do you have a team" answer is a yes.
 * @param {string} text - The answer.
 * @returns {boolean}
 */
function saysHasTeam(text) {
  return /^\s*yes\b/i.test(String(text || ""));
}

/**
 * Answer an error for the team builder.
 * @param {object} res - Express response.
 * @param {string} label - For the log.
 * @param {Error} err - The error.
 * @returns {void}
 */
function fail(res, label, err) {
  if (err && err.status) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(label + " failed:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "The team builder hit a problem. Try again." });
  }
}

/**
 * Reject query parameters the route doesn't know.
 * @param {object} query - req.query.
 * @param {Array<string>} allowed - Known names.
 * @returns {string} An error, or "".
 */
function unknownParams(query, allowed) {
  var unknown = Object.keys(query || {}).filter(function isUnknown(key) {
    return allowed.indexOf(key) === -1;
  });
  return unknown.length ? "Unknown parameter: " + unknown.join(", ") + "." : "";
}

/**
 * Resolve round + statuses for a request, answering 400/404 itself.
 * @param {object} res - Express response.
 * @param {*} roundParam - Round id or "".
 * @param {*} statusParam - Statuses.
 * @returns {Promise<object|null>} { round, rounds, statuses }, or null when answered.
 */
async function readScope(res, roundParam, statusParam) {
  var parsed = readStatuses(statusParam);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return null;
  }
  var loaded = await loadRound(roundParam);
  if (loaded.error) {
    res.status(loaded.status).json({ error: loaded.error });
    return null;
  }
  return { round: loaded.round, rounds: loaded.rounds, statuses: parsed.statuses };
}

/**
 * @param {Array<object>} rounds - Lean rounds.
 * @returns {Array<object>} For the round picker.
 */
function roundList(rounds) {
  return rounds.map(function toRound(r) {
    return { _id: r._id, name: r.name, isOpen: Boolean(r.isOpen) };
  });
}

/**
 * @param {Array<object>} proposals - Built proposals.
 * @param {string} status - "ready" | "conflict" | "done".
 * @returns {number}
 */
function countStatus(proposals, status) {
  return proposals.filter(function has(p) {
    return p.status === status;
  }).length;
}

/**
 * GET /api/admin/team-builder/proposals?round=&statuses=accepted,pending
 * Proposed teams from the round's teammates answers, with flags, plus the
 * applicants who wrote something that matched no one, and recent runs.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function getProposals(req, res) {
  try {
    var bad = unknownParams(req.query, ["round", "statuses"]);
    if (bad) {
      res.status(400).json({ error: bad });
      return;
    }
    var scope = await readScope(res, req.query.round, req.query.statuses);
    if (!scope) {
      return;
    }
    var recent = await TeamBuilderRun.find({})
      .sort({ createdAt: -1 })
      .limit(5)
      .select("by createdAt totals statuses")
      .populate("by", "name")
      .lean();
    var runs = recent.map(function toRun(run) {
      return { _id: run._id, by: run.by ? run.by.name : "", at: run.createdAt, totals: run.totals, statuses: run.statuses };
    });
    if (!scope.round) {
      res.status(200).json({ round: null, rounds: [], statuses: scope.statuses, proposals: [], unmatched: [], runs: runs });
      return;
    }
    var ctx = await loadContext(scope.round, scope.statuses);
    var built = teamProposals.buildProposals(ctx.input);
    var inScope = ctx.applications.filter(function isIn(a) {
      return a.inScope;
    });
    var saidTeam = ctx.questions.hasTeam
      ? inScope.filter(function yes(a) {
          return saysHasTeam(teamProposals.answerText(a.doc.answers, ctx.questions.hasTeam));
        }).length
      : null;
    var listedSomeone = inScope.filter(function wrote(a) {
      return teamProposals.extractEmails(a.teammates).length > 0;
    }).length;
    res.status(200).json({
      round: { _id: scope.round._id, name: scope.round.name, isOpen: Boolean(scope.round.isOpen) },
      rounds: roundList(scope.rounds),
      statuses: scope.statuses,
      maxSize: ctx.maxSize,
      questions: {
        teammates: questionSummary(ctx.questions.teammates),
        hasTeam: questionSummary(ctx.questions.hasTeam),
      },
      counts: {
        inScope: inScope.length,
        saidHasTeam: saidTeam,
        listedSomeone: listedSomeone,
        proposals: built.proposals.length,
        ready: countStatus(built.proposals, "ready"),
        conflicts: countStatus(built.proposals, "conflict"),
        done: countStatus(built.proposals, "done"),
        unmatched: built.unmatched.length,
      },
      proposals: built.proposals,
      unmatched: built.unmatched,
      runs: runs,
      emailConfigured: mailer.isMailConfigured(),
    });
  } catch (err) {
    fail(res, "getProposals (team builder)", err);
  }
}

/**
 * Validate the body of an apply request.
 * @param {object} body - req.body.
 * @returns {{error: string}|{requests: Array<object>}}
 */
function readApplyBody(body) {
  var list = body && body.proposals;
  if (!Array.isArray(list) || !list.length) {
    return { error: "Send proposals: a list of { memberEmails, name, leaderEmail, mergeIntoTeamId }." };
  }
  if (list.length > MAX_PROPOSALS_PER_RUN) {
    return { error: "At most " + MAX_PROPOSALS_PER_RUN + " teams per run." };
  }
  var requests = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    if (!item || typeof item !== "object" || !Array.isArray(item.memberEmails)) {
      return { error: "Proposal " + (i + 1) + " needs memberEmails (a list)." };
    }
    if (item.memberEmails.length > MAX_MEMBERS_PER_PROPOSAL) {
      return { error: "Proposal " + (i + 1) + " lists too many people." };
    }
    var emails = item.memberEmails
      .filter(function isText(e) {
        return typeof e === "string";
      })
      .map(teamProposals.normalizeEmail)
      .filter(Boolean);
    var name = item.name === undefined || item.name === null ? "" : String(item.name).trim().replace(/\s+/g, " ");
    if (name && (name.length < 2 || name.length > 60)) {
      return { error: "Team names are 2 to 60 characters (proposal " + (i + 1) + ")." };
    }
    var merge = item.mergeIntoTeamId ? String(item.mergeIntoTeamId) : "";
    if (merge && !mongoose.isValidObjectId(merge)) {
      return { error: "mergeIntoTeamId is not a valid id (proposal " + (i + 1) + ")." };
    }
    requests.push({
      memberEmails: emails,
      name: name,
      leaderEmail: typeof item.leaderEmail === "string" ? teamProposals.normalizeEmail(item.leaderEmail) : "",
      mergeIntoTeamId: merge,
    });
  }
  return { requests: requests };
}

/**
 * The server-built proposal a request is about: the one holding all of its
 * emails, or null when they don't belong to one proposal.
 * @param {object} request - From readApplyBody.
 * @param {object} byKey - matchKey -> proposal.
 * @returns {object|null}
 */
function proposalFor(request, byKey) {
  var found = null;
  for (var i = 0; i < request.memberEmails.length; i++) {
    var proposal = byKey[teamProposals.matchKey(request.memberEmails[i])];
    if (!proposal || (found && proposal !== found)) {
      return null;
    }
    found = proposal;
  }
  return found;
}

/**
 * Re-read the current team and invite state of a proposal's members (inside
 * the lock), so the plan never acts on a stale page.
 * @param {object} proposal - Server-built proposal.
 * @param {string} mergeId - Merge target id, or "".
 * @returns {Promise<{proposal: object, mergeTeam: (object|null)}>}
 */
async function refresh(proposal, mergeId) {
  var userIds = proposal.members
    .filter(function hasId(m) {
      return m.userId;
    })
    .map(function id(m) {
      return m.userId;
    });
  var keys = {};
  proposal.members.forEach(function mark(m) {
    keys[teamProposals.matchKey(m.email)] = m;
    keys[teamProposals.matchKey(m.listedEmail || m.email)] = m;
  });
  var emails = [];
  proposal.members.forEach(function add(m) {
    emails.push(m.email);
    if (m.listedEmail && m.listedEmail !== m.email) {
      emails.push(m.listedEmail);
    }
  });
  var or = [{ members: { $in: userIds } }, { "invites.email": { $in: emails } }];
  if (mergeId) {
    or.push({ _id: mergeId });
  }
  var teams = indexTeams(await Team.find({ $or: or }).select("name nameKey leader members invites lockedAt").lean());
  var members = proposal.members.map(function fresh(m) {
    var copy = Object.assign({}, m);
    var team = m.userId ? teams.teamByUser[m.userId] : null;
    copy.team = team ? { id: team.id, name: team.name, locked: team.locked, size: team.size, invites: team.invites } : null;
    var invited = (teams.invitesByKey[teamProposals.matchKey(m.email)] || []).concat(
      m.listedEmail ? teams.invitesByKey[teamProposals.matchKey(m.listedEmail)] || [] : []
    );
    var seen = {};
    copy.invitedTo = invited
      .filter(function unique(t) {
        if (seen[t.id]) {
          return false;
        }
        seen[t.id] = true;
        return true;
      })
      .map(function toTeam(t) {
        return { id: t.id, name: t.name };
      });
    return copy;
  });
  return {
    proposal: Object.assign({}, proposal, { members: members }),
    mergeTeam: mergeId ? teams.byId[mergeId] || null : null,
  };
}

/**
 * A free team name: the wanted one (or "Team <leader>"), with a number added
 * while it collides with an existing team or one made earlier in this run.
 * @param {string} wanted - Requested name, may be "".
 * @param {object} leader - Leader member.
 * @param {object} taken - nameKey -> true; updated.
 * @returns {Promise<string>}
 */
async function freeName(wanted, leader, taken) {
  for (var attempt = 0; attempt < 50; attempt++) {
    var name = chooseName(wanted, leader.name, taken);
    if (!(await Team.exists({ nameKey: Team.nameKeyFor(name) }))) {
      return name;
    }
  }
  throw control.problem(409, "Couldn't find a free team name for " + (wanted || leader.name) + ".");
}

/**
 * The wanted team name made unique, or the default ("<First name>'s team",
 * then with the last name, then numbered) when none was asked for.
 * @param {string} wanted - Requested name, may be "".
 * @param {string} leaderName - The leader's name.
 * @param {object} taken - nameKey -> true; updated.
 * @returns {string}
 */
function chooseName(wanted, leaderName, taken) {
  return wanted
    ? teamProposals.uniqueTeamName(wanted, taken, Team.nameKeyFor)
    : teamProposals.proposalTeamName(leaderName, taken, Team.nameKeyFor);
}

/**
 * Carry out one plan inside the team lock.
 * @param {object} plan - From teamProposals.planApply.
 * @param {object} admin - req.user.
 * @param {object} taken - Names taken so far (nameKey -> true).
 * @param {object|null} mergeTeam - Fresh merge target (with leaderId), when merging.
 * @returns {Promise<object>} { team, inviterName, addedIds } for after the lock.
 */
async function execute(plan, admin, taken, mergeTeam) {
  var now = new Date();
  if (plan.action === "create") {
    var addIds = [plan.leader.userId].concat(
      plan.add.map(function id(m) {
        return m.userId;
      })
    );
    var changes = addIds.map(function added(id) {
      return { by: admin.id, at: now, action: "builder_add", user: id };
    });
    plan.invite.forEach(function invited(m) {
      changes.push({ by: admin.id, at: now, action: "builder_invite", email: m.email });
    });
    var name = await freeName(plan.name, plan.leader, taken);
    var team = await Team.create({
      name: name,
      nameKey: Team.nameKeyFor(name),
      leader: plan.leader.userId,
      members: addIds,
      invites: plan.invite.map(function toInvite(m) {
        return { email: m.email, invitedBy: plan.leader.userId, invitedAt: now };
      }),
      staffChanges: changes,
    });
    return { team: team, inviterName: plan.leader.name, addedIds: addIds };
  }
  // Merging: the team's leader is the inviter, as if they had sent the
  // invites themselves.
  var leaderId = mergeTeam && mergeTeam.leaderId ? mergeTeam.leaderId : undefined;
  var target = await Team.findOneAndUpdate(
    { _id: plan.teamId, lockedAt: null },
    {
      $push: {
        invites: {
          $each: plan.invite.map(function toInvite(m) {
            return { email: m.email, invitedBy: leaderId, invitedAt: now };
          }),
        },
        staffChanges: {
          $each: plan.invite.map(function invited(m) {
            return { by: admin.id, at: now, action: "builder_invite", email: m.email };
          }),
        },
      },
    },
    { new: true }
  ).populate("leader", "name");
  if (!target) {
    throw control.problem(423, "That team was just locked for judging.");
  }
  return { team: target, inviterName: target.leader ? target.leader.name : "A teammate", addedIds: [] };
}

/**
 * Send the invite emails for one applied plan (fire and forget: the outbox
 * records, paces and retries them).
 * @param {object} plan - Applied plan.
 * @param {object} done - From execute.
 * @param {object} admin - req.user.
 * @returns {void}
 */
function sendInvites(plan, done, admin) {
  plan.invite.forEach(function each(m) {
    mailer
      .sendTemplateEmail(
        m.email,
        "team_invite",
        {
          inviterName: done.inviterName || "A teammate",
          teamName: done.team.name,
          teamsUrl: primaryClientOrigin() + "/dashboard/team",
        },
        { userId: m.userId || undefined, requestedBy: admin.id }
      )
      .catch(function onMailError(err) {
        console.error("Team builder invite email failed:", err);
      });
  });
  done.addedIds.forEach(function notify(id) {
    hardwareTeamChange(id);
  });
}

/**
 * The response row for one request.
 * @param {object} request - From readApplyBody.
 * @param {object|null} proposal - Server proposal.
 * @param {object} plan - Plan (possibly skipped).
 * @param {object|null} team - Created or merged team.
 * @returns {object}
 */
function resultRow(request, proposal, plan, team) {
  var action = plan.action === "create" ? "created" : plan.action === "merge" ? "merged" : "skipped";
  var added = plan.action === "create" ? [plan.leader].concat(plan.add) : [];
  return {
    proposalId: proposal ? proposal.id : null,
    action: action,
    teamId: team ? String(team._id) : plan.teamId || null,
    teamName: team ? team.name : plan.name || "",
    reason: plan.reason || "",
    added: added.map(function email(m) {
      return m.email;
    }),
    invited: plan.invite.map(function email(m) {
      return m.email;
    }),
    skipped: plan.skipped,
  };
}

/**
 * Add up the results.
 * @param {Array<object>} results - Result rows.
 * @returns {object} { created, merged, added, invited, skipped, skippedTeams }
 */
function totalsOf(results) {
  var totals = { created: 0, merged: 0, added: 0, invited: 0, skipped: 0, skippedTeams: 0 };
  results.forEach(function add(r) {
    if (r.action === "created") totals.created += 1;
    if (r.action === "merged") totals.merged += 1;
    if (r.action === "skipped") totals.skippedTeams += 1;
    totals.added += r.added.length;
    totals.invited += r.invited.length;
    totals.skipped += r.skipped.length;
  });
  return totals;
}

/**
 * POST /api/admin/team-builder/apply
 * Body: { proposals: [{ memberEmails, name?, leaderEmail?, mergeIntoTeamId? }],
 *         round?, statuses?, dryRun?, allowOverLimit? }
 *
 * Create the proposed teams (or invite people to an existing team). The
 * server rebuilds the proposals for the same round and statuses and only
 * acts on people who are in one of them: memberEmails can narrow a proposal,
 * never add someone to it. People already on a team or invited are left
 * alone, so running it again is safe. With `dryRun` it only reports.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function applyProposals(req, res) {
  try {
    var body = req.body || {};
    var importing = body.imported !== undefined;
    var parsed = importing ? { requests: [] } : readApplyBody(body);
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    var imported = null;
    if (importing) {
      var settings = await OrgSettings.getSingleton();
      imported = readImported(body.imported, settings.teamMaxSize || 4);
      if (imported.error) {
        res.status(400).json({ error: imported.error });
        return;
      }
    }
    var scope = await readScope(res, body.round, body.statuses);
    if (!scope) {
      return;
    }
    if (!scope.round) {
      res.status(400).json({ error: "There is no application round to build teams from." });
      return;
    }
    var ctx = await loadContext(scope.round, scope.statuses, imported ? imported.teams : null);
    if (importing) {
      parsed = { requests: ctx.importedRequests };
    }
    var built = teamProposals.buildProposals(ctx.input);
    var byKey = {};
    built.proposals.forEach(function index(p) {
      p.members.forEach(function each(m) {
        byKey[teamProposals.matchKey(m.email)] = p;
        byKey[teamProposals.matchKey(m.listedEmail || m.email)] = p;
      });
    });

    var dryRun = body.dryRun === true;
    var stale = "These people aren't one proposed team any more. Refresh the page and try again.";

    // A first pass on the loaded state: the preview for dryRun, and the
    // invite count for the daily sending limit.
    var dryTaken = {};
    ctx.teams.takenNames.forEach(function mark(key) {
      dryTaken[key] = true;
    });
    var preview = parsed.requests.map(function plan(request) {
      var proposal = proposalFor(request, byKey);
      if (!proposal) {
        return resultRow(request, null, { action: "skip", reason: stale, add: [], invite: [], skipped: [] }, null);
      }
      var p = teamProposals.planApply(proposal, request, {
        maxSize: ctx.maxSize,
        mergeTeam: request.mergeIntoTeamId ? ctx.teams.byId[request.mergeIntoTeamId] || null : null,
      });
      if (p.action === "create") {
        p.name = chooseName(p.name, p.leader.name, dryTaken);
      }
      return resultRow(request, proposal, p, null);
    });
    var previewTotals = totalsOf(preview);
    var limit = outbox.dailyLimit();
    var committed = await outbox.committedInLastDay();
    var overLimit = limit > 0 && committed + previewTotals.invited > limit;
    var quota = { dailyLimit: limit, committedLast24h: committed, overLimit: overLimit, emailConfigured: mailer.isMailConfigured() };

    if (dryRun) {
      res.status(200).json(Object.assign({ dryRun: true, totals: previewTotals, results: preview }, quota));
      return;
    }
    if (overLimit && body.allowOverLimit !== true) {
      res.status(409).json(
        Object.assign(
          {
            error:
              "These invites would put you over the sending limit (" + limit + " emails per 24 hours): " +
              committed + " already sent or waiting plus " + previewTotals.invited +
              " new. Send fewer, wait, or send anyway; the ones over the limit will fail and be retried later.",
            code: "OVER_DAILY_LIMIT",
          },
          quota
        )
      );
      return;
    }

    var taken = {};
    ctx.teams.takenNames.forEach(function mark(key) {
      taken[key] = true;
    });
    var results = [];
    for (var i = 0; i < parsed.requests.length; i++) {
      var request = parsed.requests[i];
      var proposal = proposalFor(request, byKey);
      if (!proposal) {
        results.push(resultRow(request, null, { action: "skip", reason: stale, add: [], invite: [], skipped: [] }, null));
        continue;
      }
      var outcome;
      try {
        outcome = await control.locked(async function applyOne() {
          var fresh = await refresh(proposal, request.mergeIntoTeamId);
          var plan = teamProposals.planApply(fresh.proposal, request, { maxSize: ctx.maxSize, mergeTeam: fresh.mergeTeam });
          if (plan.action === "skip") {
            return { plan: plan, done: null };
          }
          return { plan: plan, done: await execute(plan, req.user, taken, fresh.mergeTeam) };
        });
      } catch (err) {
        var reason = err && err.code === DUPLICATE_KEY
          ? "Someone here just joined another team. Refresh and try again."
          : err && err.status
            ? err.message
            : null;
        if (!reason) {
          throw err;
        }
        results.push(resultRow(request, proposal, { action: "skip", reason: reason, add: [], invite: [], skipped: [] }, null));
        continue;
      }
      if (outcome.done) {
        sendInvites(outcome.plan, outcome.done, req.user);
      }
      results.push(resultRow(request, proposal, outcome.plan, outcome.done ? outcome.done.team : null));
    }

    var totals = totalsOf(results);
    var run = await TeamBuilderRun.create({
      by: req.user.id,
      round: scope.round._id,
      statuses: scope.statuses,
      totals: totals,
      results: results.map(function toAudit(r) {
        return {
          action: r.action,
          team: r.teamId || undefined,
          teamName: r.teamName,
          reason: r.reason,
          added: r.added,
          invited: r.invited,
          skipped: r.skipped.map(function s(x) {
            return { email: x.email, reason: x.reason };
          }),
        };
      }),
    });
    res.status(200).json(Object.assign({ dryRun: false, runId: run._id, totals: totals, results: results }, quota));
  } catch (err) {
    fail(res, "applyProposals (team builder)", err);
  }
}

/**
 * The people a conflict email goes to, with the text for each: listers in a
 * conflicting group who are in scope, can still join a team and are on none.
 * @param {Array<object>} proposals - Built proposals.
 * @returns {Array<object>} [{ userId, email, name, signature, details }]
 */
function conflictRecipients(proposals) {
  var out = [];
  var seen = {};
  proposals.forEach(function eachProposal(p) {
    if (p.status !== "conflict") {
      return;
    }
    p.conflict.listers.forEach(function eachLister(l) {
      if (!l.inScope || !l.userId || l.status === "rejected" || l.role === "judge" || l.team || seen[l.userId]) {
        return;
      }
      seen[l.userId] = true;
      out.push({
        userId: l.userId,
        email: l.email,
        name: l.name,
        signature: p.conflict.signature,
        details: teamProposals.conflictDetails(p.conflict, l.email),
      });
    });
  });
  return out;
}

/**
 * Split recipients into those still to be emailed and those already told
 * about these exact lists.
 * @param {Array<object>} recipients - From conflictRecipients.
 * @param {object} round - The round.
 * @returns {Promise<{fresh: Array<object>, already: Array<object>}>}
 */
async function splitByNotice(recipients, round) {
  var notices = await TeamConflictNotice.find({
    round: round._id,
    user: { $in: recipients.map(function id(r) { return r.userId; }) },
  })
    .select("user signature")
    .lean();
  var told = {};
  notices.forEach(function mark(n) {
    told[String(n.user)] = n.signature;
  });
  var fresh = [];
  var already = [];
  recipients.forEach(function sort(r) {
    (told[r.userId] === r.signature ? already : fresh).push(r);
  });
  return { fresh: fresh, already: already };
}

/**
 * POST /api/admin/team-builder/notify-conflicts
 * Body: { round?, statuses?, dryRun?, allowOverLimit? }
 *
 * Email every lister in a conflicting group (their list doesn't match
 * another's, or the group is too big) the `team_conflict` message. Each
 * person is told once per set of lists: a re-run skips them until the lists
 * change. With `dryRun` it only counts.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function notifyConflicts(req, res) {
  try {
    var body = req.body || {};
    var unknown = Object.keys(body).filter(function isUnknown(key) {
      return ["round", "statuses", "dryRun", "allowOverLimit"].indexOf(key) === -1;
    });
    if (unknown.length) {
      res.status(400).json({ error: "Unknown field: " + unknown.join(", ") + "." });
      return;
    }
    var scope = await readScope(res, body.round, body.statuses);
    if (!scope) {
      return;
    }
    if (!scope.round) {
      res.status(400).json({ error: "There is no application round to build teams from." });
      return;
    }
    var ctx = await loadContext(scope.round, scope.statuses);
    var built = teamProposals.buildProposals(ctx.input);
    var recipients = conflictRecipients(built.proposals);
    var split = await splitByNotice(recipients, scope.round);
    var limit = outbox.dailyLimit();
    var committed = await outbox.committedInLastDay();
    var overLimit = limit > 0 && committed + split.fresh.length > limit;
    var quota = { dailyLimit: limit, committedLast24h: committed, overLimit: overLimit, emailConfigured: mailer.isMailConfigured() };
    var counts = {
      conflicts: countStatus(built.proposals, "conflict"),
      people: recipients.length,
      toEmail: split.fresh.length,
      alreadyEmailed: split.already.length,
    };
    if (body.dryRun === true) {
      res.status(200).json(Object.assign({ dryRun: true, emailed: 0 }, counts, quota));
      return;
    }
    if (overLimit && body.allowOverLimit !== true) {
      res.status(409).json(
        Object.assign(
          {
            error:
              "These emails would put you over the sending limit (" + limit + " per 24 hours): " + committed +
              " already sent or waiting plus " + split.fresh.length + " new. Wait, or send anyway; the ones over the limit will fail and be retried later.",
            code: "OVER_DAILY_LIMIT",
          },
          quota
        )
      );
      return;
    }
    var emailed = 0;
    for (var i = 0; i < split.fresh.length; i++) {
      var r = split.fresh[i];
      try {
        // Claims the person first; a concurrent run for the same lists finds
        // the notice and loses (duplicate key), so nobody is told twice.
        await TeamConflictNotice.updateOne(
          { user: r.userId, round: scope.round._id, signature: { $ne: r.signature } },
          { $set: { signature: r.signature, email: r.email, sentAt: new Date() } },
          { upsert: true }
        );
      } catch (err) {
        if (err && err.code === DUPLICATE_KEY) {
          continue;
        }
        throw err;
      }
      emailed += 1;
      mailer
        .sendTemplateEmail(
          r.email,
          "team_conflict",
          { name: r.name, conflictDetails: r.details, teamsUrl: primaryClientOrigin() + "/dashboard/team" },
          { userId: r.userId, requestedBy: req.user.id }
        )
        .catch(function onMailError(err) {
          console.error("Team builder conflict email failed:", err);
        });
    }
    res.status(200).json(Object.assign({ dryRun: false, emailed: emailed }, counts, { toEmail: emailed, alreadyEmailed: counts.alreadyEmailed + (split.fresh.length - emailed) }, quota));
  } catch (err) {
    fail(res, "notifyConflicts (team builder)", err);
  }
}

/**
 * Everyone in a conflicting group of accepted applicants, by match key.
 * @param {object} round - The round.
 * @returns {Promise<object>} matchKey -> true.
 */
async function conflictEmails(round) {
  var ctx = await loadContext(round, ["accepted"]);
  var marked = {};
  teamProposals.buildProposals(ctx.input).proposals.forEach(function each(p) {
    if (p.status === "conflict") {
      p.members.forEach(function mark(m) {
        marked[teamProposals.matchKey(m.email)] = true;
      });
    }
  });
  return marked;
}

/**
 * Accepted applicants of the round on no team and with no pending invite,
 * with their research-study, pairing and team-formation answers.
 * @param {object} round - The round.
 * @returns {Promise<object>} { questions, people }
 */
async function loadUnteamed(round) {
  var questions = teamProposals.teamQuestions(round.formConfig);
  var docs = await Application.find(activeApplications.active({ round: round._id, status: "accepted" }))
    .select("applicant name status createdAt answers university major")
    .populate("applicant", "name email role")
    .sort({ createdAt: 1 })
    .lean();
  var teams = indexTeams(await Team.find({}).select("name nameKey leader members invites lockedAt").lean());
  var inConflict = await conflictEmails(round);
  var people = docs
    .filter(function free(doc) {
      if (!doc.applicant || !doc.applicant.email || doc.applicant.role === "judge") {
        return false;
      }
      return !teams.teamByUser[String(doc.applicant._id)] && !teams.invitesByKey[teamProposals.matchKey(doc.applicant.email)];
    })
    .map(function toPerson(doc) {
      return {
        applicationId: doc._id,
        name: doc.name || doc.applicant.name || "",
        email: doc.applicant.email,
        university: doc.university || "",
        major: doc.major || "",
        research: teamProposals.answerText(doc.answers, questions.research),
        pairing: teamProposals.answerText(doc.answers, questions.pairing),
        formationEvent: teamProposals.answerText(doc.answers, questions.formationEvent),
        hasTeam: teamProposals.answerText(doc.answers, questions.hasTeam),
        teammates: teamProposals.answerText(doc.answers, questions.teammates),
        conflict: Boolean(inConflict[teamProposals.matchKey(doc.applicant.email)]),
      };
    });
  return { questions: questions, people: people };
}

/**
 * Split people by their research-study answer: the question's options in
 * order, then any other answers, then "No answer".
 * @param {Array<object>} people - From loadUnteamed.
 * @param {object|null} question - The research question.
 * @returns {Array<object>} [{ value, label, count, people }]
 */
function groupByResearch(people, question) {
  var groups = {};
  var order = [];
  function group(value, label) {
    if (!groups[value]) {
      groups[value] = { value: value, label: label, count: 0, people: [] };
      order.push(value);
    }
    return groups[value];
  }
  ((question && question.options) || []).forEach(function seed(option) {
    group(String(option), String(option));
  });
  var none = [];
  people.forEach(function place(person) {
    if (!person.research) {
      none.push(person);
      return;
    }
    var g = group(person.research, person.research);
    g.people.push(person);
    g.count += 1;
  });
  var list = order.map(function pick(value) {
    return groups[value];
  });
  list.push({ value: NO_ANSWER, label: question ? "No answer" : "Everyone (no research question on this form)", count: none.length, people: none });
  return list;
}

/**
 * GET /api/admin/team-builder/unteamed?round=
 * Accepted people on no team and with no pending invite, split by their
 * research-study answer.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function getUnteamed(req, res) {
  try {
    var bad = unknownParams(req.query, ["round"]);
    if (bad) {
      res.status(400).json({ error: bad });
      return;
    }
    var loaded = await loadRound(req.query.round);
    if (loaded.error) {
      res.status(loaded.status).json({ error: loaded.error });
      return;
    }
    if (!loaded.round) {
      res.status(200).json({ round: null, total: 0, groups: [], questions: {} });
      return;
    }
    var data = await loadUnteamed(loaded.round);
    res.status(200).json({
      round: { _id: loaded.round._id, name: loaded.round.name },
      total: data.people.length,
      questions: {
        research: questionSummary(data.questions.research),
        pairing: questionSummary(data.questions.pairing),
        formationEvent: questionSummary(data.questions.formationEvent),
      },
      groups: groupByResearch(data.people, data.questions.research),
    });
  } catch (err) {
    fail(res, "getUnteamed (team builder)", err);
  }
}

/**
 * GET /api/admin/team-builder/unteamed.csv?round=&answer=
 * The same people as a CSV; `answer` picks one research-study group (its
 * value, or "__none__" for no answer), otherwise everyone.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
async function exportUnteamed(req, res) {
  try {
    var bad = unknownParams(req.query, ["round", "answer"]);
    if (bad) {
      res.status(400).json({ error: bad });
      return;
    }
    if (req.query.answer !== undefined && typeof req.query.answer !== "string") {
      res.status(400).json({ error: "answer must be one value." });
      return;
    }
    var loaded = await loadRound(req.query.round);
    if (loaded.error) {
      res.status(loaded.status).json({ error: loaded.error });
      return;
    }
    var people = [];
    var questions = teamProposals.teamQuestions([]);
    if (loaded.round) {
      var data = await loadUnteamed(loaded.round);
      people = data.people;
      questions = data.questions;
    }
    var answer = req.query.answer;
    if (answer !== undefined) {
      people = people.filter(function inGroup(p) {
        return answer === NO_ANSWER ? !p.research : p.research === answer;
      });
    }
    function label(question, fallback) {
      return question ? question.label || question.key : fallback;
    }
    var header = [
      "Name",
      "Email",
      "University",
      "Major",
      label(questions.research, "Research study"),
      label(questions.pairing, "Team pairing"),
      label(questions.formationEvent, "Team formation event"),
      label(questions.hasTeam, "Has a team"),
      label(questions.teammates, "Teammates"),
    ];
    var sent = false;
    await csv.sendCsv(res, {
      filename: csv.datedFilename("not-on-a-team", "csv"),
      header: header,
      nextRows: function nextRows() {
        if (sent) {
          return Promise.resolve([]);
        }
        sent = true;
        return Promise.resolve(
          people.map(function toRow(p) {
            return [p.name, p.email, p.university, p.major, p.research, p.pairing, p.formationEvent, p.hasTeam, p.teammates];
          })
        );
      },
    });
  } catch (err) {
    fail(res, "exportUnteamed (team builder)", err);
  }
}

module.exports = {
  getProposals: getProposals,
  applyProposals: applyProposals,
  notifyConflicts: notifyConflicts,
  getUnteamed: getUnteamed,
  exportUnteamed: exportUnteamed,
  readStatuses: readStatuses,
};
