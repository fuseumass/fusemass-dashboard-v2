"use strict";

var Application = require("../schemas/application");
var activeApplications = require("../utils/activeApplications");
var ApplicationRound = require("../schemas/applicationRound");
var User = require("../schemas/user");
var applicationStatus = require("../utils/applicationStatus");
var csv = require("../utils/csv");
var statsUtil = require("../utils/stats");
var userGroups = require("../utils/userGroups");
var exportController = require("./exportController");

// Admin "User groups" (mounted at /api/admin/groups behind isAdmin): pick a
// segment of one round's applicants by email domain, status, dietary needs,
// form answers, check-in and flag, then see its breakdowns, download it as a
// CSV or copy its emails. Counting happens in MongoDB; only the CSV and the
// email list carry personal data.

// How many rows each breakdown keeps before folding the rest into "other".
var TOP_BREAKDOWN = 15;
// Domains offered as one-click filters.
var TOP_DOMAINS = 30;
// Most groups one $group may hand back (free text can have thousands).
var MAX_GROUPS = 2000;
// Answers that aren't one of the question's options (an "Other" choice)
// listed per question, most common first.
var MAX_EXTRA_VALUES = 25;
// Applications read per round trip by the CSV export.
var BATCH_SIZE = 500;

/**
 * Load every round and pick the one the request is about.
 * @param {object} query - req.query.
 * @returns {Promise<{error: string, status: number}|{round: object|null, rounds: Array<object>}>}
 */
function loadRound(query) {
  var param = userGroups.readRoundParam(query);
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
      if (!round) {
        return { error: "Round not found.", status: 404 };
      }
      return { round: round, rounds: rounds };
    });
}

/**
 * Load the round and validate the filters; answers 400/404 itself when they
 * are wrong.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<{round: object|null, rounds: Array<object>, filters: object}|null>}
 *   null when a response was already sent.
 */
function readRequest(req, res) {
  return loadRound(req.query).then(function afterRound(loaded) {
    if (loaded.error) {
      res.status(loaded.status).json({ error: loaded.error });
      return null;
    }
    var parsed = userGroups.parseFilters(req.query, loaded.round);
    if (parsed.error) {
      res.status(400).json({ error: parsed.error });
      return null;
    }
    return { round: loaded.round, rounds: loaded.rounds, filters: parsed.filters };
  });
}

/**
 * @param {object} round - Round document.
 * @returns {{_id: *, name: string, isOpen: boolean}}
 */
function roundSummary(round) {
  return { _id: round._id, name: round.name, isOpen: Boolean(round.isOpen) };
}

/**
 * Filters with nothing set (every submitted application in the round).
 * @returns {object}
 */
function noFilters() {
  return userGroups.parseFilters({}, null).filters;
}

/**
 * Group stage rows into [{label, count}] (case-insensitive text grouping).
 * @param {string} path - Field path with "$", e.g. "$university".
 * @returns {Array<object>} Aggregation stages.
 */
function countByText(path) {
  return [
    {
      $group: {
        _id: { $toLower: { $trim: { input: { $toString: { $ifNull: [path, ""] } } } } },
        label: { $first: path },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, _id: 1 } },
    { $limit: MAX_GROUPS },
    { $project: { _id: 0, label: 1, count: 1 } },
  ];
}

/**
 * Counts of each status, zero-filled.
 * @param {Array<{_id: string, count: number}>} groups - Grouped by status.
 * @returns {object}
 */
function statusCounts(groups) {
  var counts = {};
  applicationStatus.APPLICATION_STATUSES.forEach(function zero(status) {
    counts[status] = 0;
  });
  groups.forEach(function add(group) {
    if (Object.prototype.hasOwnProperty.call(counts, group._id)) {
      counts[group._id] = group.count;
    }
  });
  return counts;
}

/**
 * Count each choice of the filterable questions over a round's submitted
 * applications, as the filter UI lists them: the form's options in order,
 * then any other answers given ("Other" text), most common first.
 * @param {object} round - The round.
 * @param {Array<object>} questions - From userGroups.filterableQuestions.
 * @returns {Promise<Array<object>>} Questions with `values: [{value, count}]`.
 */
function questionChoices(round, questions) {
  if (!questions.length) {
    return Promise.resolve([]);
  }
  var keys = questions.map(function toKey(question) {
    return question.key;
  });
  var match = activeApplications.active({ round: round._id, status: { $ne: "draft" } });
  return Promise.all([
    Application.aggregate([
      { $match: match },
      {
        $project: {
          _id: 0,
          a: { $objectToArray: { $cond: [{ $eq: [{ $type: "$answers" }, "object"] }, "$answers", {}] } },
        },
      },
      { $unwind: "$a" },
      { $match: { "a.k": { $in: keys } } },
      { $unwind: "$a.v" },
      { $group: { _id: { k: "$a.k", v: "$a.v" }, count: { $sum: 1 } } },
      { $limit: MAX_GROUPS * keys.length },
    ]),
    Application.countDocuments(match),
  ]).then(function toQuestions(results) {
    var counts = {};
    results[0].forEach(function add(group) {
      var key = group._id.k;
      var value = group._id.v;
      counts[key] = counts[key] || Object.create(null);
      if (value === true) {
        counts[key].Yes = (counts[key].Yes || 0) + group.count;
      } else if (typeof value === "string" && value !== "") {
        counts[key][value] = (counts[key][value] || 0) + group.count;
      }
    });
    var total = results[1];

    return questions.map(function toQuestion(question) {
      var seen = counts[question.key] || Object.create(null);
      if (question.type === "checkbox") {
        var yes = seen.Yes || 0;
        return {
          key: question.key,
          label: question.label,
          type: question.type,
          values: [
            { value: "Yes", count: yes },
            { value: "No", count: Math.max(0, total - yes) },
          ],
        };
      }
      var values = question.options.map(function toValue(option) {
        return { value: option, count: seen[option] || 0 };
      });
      var extras = Object.keys(seen)
        .filter(function notAnOption(value) {
          return question.options.indexOf(value) === -1;
        })
        .map(function toValue(value) {
          return { value: value, count: seen[value] };
        })
        .sort(function byCount(a, b) {
          return b.count - a.count || a.value.localeCompare(b.value);
        })
        .slice(0, MAX_EXTRA_VALUES);
      return { key: question.key, label: question.label, type: question.type, values: values.concat(extras) };
    });
  });
}

/**
 * GET /api/admin/groups/options[?round=<id>]
 *
 * What the filters can be set to, for one round (default: the newest open
 * one): the rounds, status counts, the most common email domains, every
 * choice question on the round's form with each answer's count, and the
 * meal-accommodations question the dietary filter reads (if any).
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getOptions(req, res) {
  var param = userGroups.readRoundParam(req.query);
  var extra = Object.keys(req.query || {}).filter(function notRound(key) {
    return key !== "round";
  });
  if (param.error || extra.length) {
    res.status(400).json({ error: param.error || "Only round can be set here." });
    return Promise.resolve();
  }

  return loadRound(req.query)
    .then(function afterRound(loaded) {
      if (loaded.error) {
        res.status(loaded.status).json({ error: loaded.error });
        return undefined;
      }
      var rounds = loaded.rounds.map(roundSummary);
      var round = loaded.round;
      if (!round) {
        res.status(200).json({ rounds: rounds, round: null, statuses: statusCounts([]), domains: [], questions: [], mealQuestions: [] });
        return undefined;
      }

      var questions = userGroups.filterableQuestions(round.formConfig);
      var everyone = userGroups.buildPipeline(round, noFilters(), User.collection.name);
      return Promise.all([
        Application.aggregate([{ $match: activeApplications.active({ round: round._id }) }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
        Application.aggregate(
          everyone.concat([
            { $group: { _id: "$_domain", count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: TOP_DOMAINS },
          ])
        ),
        questionChoices(round, questions),
      ]).then(function respond(results) {
        res.status(200).json({
          rounds: rounds,
          round: roundSummary(round),
          statuses: statusCounts(results[0]),
          domains: results[1]
            .filter(function hasDomain(group) {
              return group._id;
            })
            .map(function toDomain(group) {
              return { domain: group._id, count: group.count };
            }),
          questions: results[2],
          mealQuestions: userGroups.mealQuestions(round.formConfig).map(function toQuestion(question) {
            return { key: question.key, label: question.label };
          }),
        });
      });
    })
    .catch(function onError(err) {
      console.error("getGroupOptions failed:", err);
      res.status(500).json({ error: "Could not load the filters." });
    });
}

/**
 * GET /api/admin/groups?round=&domain=&subdomains=&status=&dietary=&answer=&checkedIn=&flagged=
 *
 * How many applicants match, and the group's breakdowns: status, email
 * domain, school, T-shirt size, dietary needs, check-in and flags. Counts
 * only; no names or emails.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getGroup(req, res) {
  return readRequest(req, res)
    .then(function afterRequest(ctx) {
      if (!ctx) {
        return undefined;
      }
      if (!ctx.round) {
        res.status(200).json({ round: null, total: 0 });
        return undefined;
      }
      var pipeline = userGroups.buildPipeline(ctx.round, ctx.filters, User.collection.name);
      pipeline.push({
        $facet: {
          byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          byDomain: countByText("$_domain"),
          byUniversity: countByText("$university"),
          byTshirtSize: countByText("$tshirtSize"),
          flags: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                restrictions: { $sum: { $cond: ["$_restriction", 1, 0] } },
                accommodations: { $sum: { $cond: ["$_accommodation", 1, 0] } },
                anyDietary: { $sum: { $cond: [{ $or: ["$_restriction", "$_accommodation"] }, 1, 0] } },
                checkedIn: { $sum: { $cond: [{ $eq: ["$_user.checkedIn", true] }, 1, 0] } },
                flagged: { $sum: { $cond: [{ $eq: ["$flagged", true] }, 1, 0] } },
              },
            },
          ],
        },
      });

      return Application.aggregate(pipeline).then(function respond(result) {
        var facets = result[0];
        var flags = facets.flags[0] || { total: 0, restrictions: 0, accommodations: 0, anyDietary: 0, checkedIn: 0, flagged: 0 };
        var total = flags.total;
        res.status(200).json({
          round: roundSummary(ctx.round),
          filters: ctx.filters,
          total: total,
          byStatus: statusCounts(facets.byStatus),
          byDomain: statsUtil.bucketize(facets.byDomain, TOP_BREAKDOWN),
          byUniversity: statsUtil.bucketize(facets.byUniversity, TOP_BREAKDOWN),
          byTshirtSize: statsUtil.bucketize(facets.byTshirtSize, TOP_BREAKDOWN),
          dietary: {
            restrictions: flags.restrictions,
            accommodations: flags.accommodations,
            any: flags.anyDietary,
            none: total - flags.anyDietary,
          },
          checkedIn: { yes: flags.checkedIn, no: total - flags.checkedIn },
          flagged: { yes: flags.flagged, no: total - flags.flagged },
        });
      });
    })
    .catch(function onError(err) {
      console.error("getGroup failed:", err);
      res.status(500).json({ error: "Could not load the group." });
    });
}

/**
 * GET /api/admin/groups/emails?<same filters>
 *
 * Every matching applicant's email, for the "Copy emails" button. Personal
 * data, so only sent when asked for and never cached.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getGroupEmails(req, res) {
  return readRequest(req, res)
    .then(function afterRequest(ctx) {
      if (!ctx) {
        return undefined;
      }
      res.set("Cache-Control", "no-store");
      if (!ctx.round) {
        res.status(200).json({ emails: [] });
        return undefined;
      }
      var pipeline = userGroups.buildPipeline(ctx.round, ctx.filters, User.collection.name);
      pipeline.push({ $group: { _id: "$_user.email" } }, { $sort: { _id: 1 } });
      return Application.aggregate(pipeline).then(function respond(groups) {
        res.status(200).json({
          emails: groups
            .map(function toEmail(group) {
              return group._id;
            })
            .filter(Boolean),
        });
      });
    })
    .catch(function onError(err) {
      console.error("getGroupEmails failed:", err);
      res.status(500).json({ error: "Could not load the emails." });
    });
}

// The fixed columns of the group export, in order. Each reads one row of the
// group pipeline (an application with `_user` and the dietary flags).
var GROUP_COLUMNS = [
  { header: "Name", value: function (a) { return a.name || a._user.name; } },
  { header: "Email", value: function (a) { return a._user.email; } },
  { header: "Status", value: function (a) { return a.status; } },
  { header: "University", value: function (a) { return a.university; } },
  { header: "Major", value: function (a) { return a.major; } },
  { header: "Phone", value: function (a) { return a.phone; } },
  { header: "T-shirt size", value: function (a) { return a.tshirtSize; } },
  { header: "Food restrictions", value: function (a) { return a.allergies; } },
  { header: "Meal accommodations", value: function (a, ctx) { return ctx.hasMealQuestion ? exportController.yesNo(a._accommodation) : ""; } },
  { header: "Checked in", value: function (a) { return exportController.yesNo(a._user.checkedIn); } },
  { header: "Flagged", value: function (a) { return exportController.yesNo(a.flagged); } },
];

/**
 * GET /api/admin/groups/export.csv?<same filters>
 *
 * The matching applicants as a CSV: contact and event fields, then every
 * question on the round's form as its own column (lists joined with "; ").
 * Streamed in batches through utils/csv, which also neutralizes cells that a
 * spreadsheet would run as formulas.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function exportGroup(req, res) {
  return readRequest(req, res)
    .then(function afterRequest(ctx) {
      if (!ctx) {
        return undefined;
      }
      var fixedHeaders = GROUP_COLUMNS.map(function toHeader(column) {
        return column.header;
      });
      var custom = ctx.round ? exportController.customColumns([ctx.round], fixedHeaders) : [];
      var rowCtx = { hasMealQuestion: ctx.round ? userGroups.mealQuestions(ctx.round.formConfig).length > 0 : false };
      var base = ctx.round ? userGroups.buildPipeline(ctx.round, ctx.filters, User.collection.name) : null;
      var lastId = null;
      var finished = !base;

      // Batches in _id order: the _id bound goes first so each batch only
      // looks at applications after the previous one.
      function nextRows() {
        if (finished) {
          return Promise.resolve([]);
        }
        var pipeline = base.slice();
        if (lastId) {
          pipeline[0] = { $match: Object.assign({}, base[0].$match, { _id: { $gt: lastId } }) };
        }
        pipeline.push(
          { $sort: { _id: 1 } },
          { $limit: BATCH_SIZE },
          {
            $project: {
              name: 1, status: 1, university: 1, major: 1, phone: 1, tshirtSize: 1, allergies: 1,
              flagged: 1, answers: 1, _user: 1, _accommodation: 1,
            },
          }
        );
        return Application.aggregate(pipeline).then(function toRows(docs) {
          if (docs.length < BATCH_SIZE) {
            finished = true;
          }
          if (docs.length) {
            lastId = docs[docs.length - 1]._id;
          }
          return docs.map(function toRow(application) {
            var answers = application.answers && typeof application.answers === "object" ? application.answers : {};
            return GROUP_COLUMNS.map(function fixed(column) {
              return column.value(application, rowCtx);
            }).concat(
              custom.map(function answer(column) {
                return exportController.answerCell(answers[column.key]);
              })
            );
          });
        });
      }

      return csv.sendCsv(res, {
        filename: csv.datedFilename("user-group", "csv"),
        header: fixedHeaders.concat(
          custom.map(function toHeader(column) {
            return column.header;
          })
        ),
        nextRows: nextRows,
      });
    })
    .catch(function onError(err) {
      console.error("exportGroup failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Could not build the export." });
      }
    });
}

module.exports = {
  getOptions: getOptions,
  getGroup: getGroup,
  getGroupEmails: getGroupEmails,
  exportGroup: exportGroup,
};
