"use strict";

var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var CheckIn = require("../schemas/checkin");
var MealService = require("../schemas/mealService");
var MealCheckIn = require("../schemas/mealCheckin");
var applicationScope = require("../utils/applicationScope");
var applicationStatus = require("../utils/applicationStatus");
var calendar = require("../utils/calendar");
var statsUtil = require("../utils/stats");

// Admin statistics (mounted at /api/admin/stats behind isAdmin). Every figure
// is counted inside MongoDB with $group, so the work stays the same however
// many applications there are; nothing loads every document into memory.

// How many groups each chart keeps before folding the rest into "other".
var TOP_SCHOOLS = 25;
var TOP_MAJORS = 25;
var TOP_SMALL = 12;
// Most groups one $group may hand back (free text can have thousands).
var MAX_GROUPS = 2000;
// Most custom questions charted (the graduation year is charted on its own).
var MAX_QUESTIONS = 12;

// Custom question types whose answers make sense as a chart.
var CHART_TYPES = ["select", "multiselect", "checkbox"];
// Types a graduation year may be asked as.
var GRADUATION_TYPES = ["select", "text", "number"];

/**
 * Count the applications in scope per distinct value of a text field. Values
 * are grouped ignoring case and surrounding spaces ("umass amherst " and
 * "UMass Amherst" are one school).
 * @param {object} match - From parseScope.
 * @param {string} field - Application field name, e.g. "university".
 * @returns {Promise<Array<{label: string, count: number}>>}
 */
function countByText(match, field) {
  var path = "$" + field;
  return Application.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $toLower: { $trim: { input: { $ifNull: [path, ""] } } } },
        label: { $first: path },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1, _id: 1 } },
    { $limit: MAX_GROUPS },
  ]).then(function toRows(groups) {
    return groups.map(function toRow(group) {
      return { label: group.label, count: group.count };
    });
  });
}

/**
 * Submitted-application counts per round and status, over every application
 * (the page also shows all rounds side by side).
 * @returns {Promise<Array<{round: *, status: string, count: number}>>}
 */
function countByRoundAndStatus() {
  return Application.aggregate([
    { $group: { _id: { round: "$round", status: "$status" }, count: { $sum: 1 } } },
  ]).then(function toRows(groups) {
    return groups.map(function toRow(group) {
      return { round: group._id.round || null, status: group._id.status, count: group.count };
    });
  });
}

/**
 * Applications per day (in the event's time zone) and status. The day is when
 * the application record was created, which is the closest thing we store to
 * "submitted" (it is created when the applicant first saves or submits).
 * @param {object} match - From parseScope.
 * @returns {Promise<Array<{date: string, status: string, count: number}>>}
 */
function countPerDay(match) {
  return Application.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: calendar.eventTimeZone() } },
          status: "$status",
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { "_id.day": 1 } },
  ]).then(function toRows(groups) {
    return groups.map(function toRow(group) {
      return { date: group._id.day, status: group._id.status, count: group.count };
    });
  });
}

/**
 * First-time hackers vs returning, and how many have attended this event before.
 * @param {object} match - From parseScope.
 * @returns {Promise<{firstTime: number, returning: number, attendedThisEvent: number}>}
 */
function countExperience(match) {
  return Application.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        returning: { $sum: { $cond: [{ $eq: ["$experience.attendedBefore", true] }, 1, 0] } },
        attendedThisEvent: { $sum: { $cond: [{ $eq: ["$experience.attendedThisBefore", true] }, 1, 0] } },
      },
    },
  ]).then(function toResult(groups) {
    var row = groups[0] || { total: 0, returning: 0, attendedThisEvent: 0 };
    return {
      firstTime: row.total - row.returning,
      returning: row.returning,
      attendedThisEvent: row.attendedThisEvent,
    };
  });
}

/**
 * The custom questions worth charting, from the rounds' forms: choice and
 * yes/no questions, plus the graduation year however it is asked.
 * @param {Array<object>} rounds - Rounds with a formConfig, oldest first.
 * @returns {Array<{key: string, label: string, type: string, graduation: boolean}>}
 */
function chartableQuestions(rounds) {
  var byKey = Object.create(null);
  rounds.forEach(function eachRound(round) {
    var fields = Array.isArray(round.formConfig) ? round.formConfig : [];
    fields.forEach(function eachField(field) {
      if (!field || typeof field.key !== "string" || !field.key) {
        return;
      }
      var graduation = statsUtil.isGraduationField(field) && GRADUATION_TYPES.indexOf(field.type) !== -1;
      if (CHART_TYPES.indexOf(field.type) !== -1 || graduation) {
        // A later round's wording wins.
        byKey[field.key] = {
          key: field.key,
          label: applicationScope.plainLabel(field.label || field.key),
          type: field.type,
          graduation: graduation,
        };
      } else {
        delete byKey[field.key];
      }
    });
  });

  var all = Object.keys(byKey).map(function toQuestion(key) {
    return byKey[key];
  });
  var graduation = all.filter(function isGraduation(q) {
    return q.graduation;
  })[0];
  var others = all
    .filter(function notGraduation(q) {
      return q !== graduation;
    })
    .slice(0, MAX_QUESTIONS);
  return graduation ? [graduation].concat(others) : others;
}

/**
 * Count the answers to several custom questions in a single pass over the
 * applications in scope. Multiselect answers count once per choice.
 * @param {object} match - From parseScope.
 * @param {Array<string>} keys - Question keys.
 * @returns {Promise<object>} Map of key to [{label, count}].
 */
function countAnswers(match, keys) {
  if (!keys.length) {
    return Promise.resolve({});
  }
  return Application.aggregate([
    { $match: match },
    {
      $project: {
        _id: 0,
        a: { $objectToArray: { $cond: [{ $eq: [{ $type: "$answers" }, "object"] }, "$answers", {}] } },
      },
    },
    { $unwind: "$a" },
    { $match: { "a.k": { $in: keys } } },
    // A list (multiselect) becomes one row per choice; a single value stays one row.
    { $unwind: "$a.v" },
    { $group: { _id: { k: "$a.k", v: "$a.v" }, count: { $sum: 1 } } },
    { $limit: MAX_GROUPS * keys.length },
  ]).then(function toMap(groups) {
    var byKey = {};
    groups.forEach(function add(group) {
      var label = statsUtil.answerLabel(group._id.v);
      if (label === null) {
        return;
      }
      byKey[group._id.k] = byKey[group._id.k] || [];
      byKey[group._id.k].push({ label: label, count: group.count });
    });
    return byKey;
  });
}

/**
 * Turn the status-by-round counts into the page's tables.
 * @param {Array<object>} rows - From countByRoundAndStatus.
 * @param {Array<object>} rounds - Every round (so empty rounds still list).
 * @param {{round: string, status: string}} scope - From parseScope.
 * @returns {{total: number, byStatus: object, byRound: Array<object>}}
 */
function summarizeStatuses(rows, rounds, scope) {
  function emptyStatuses() {
    var counts = {};
    applicationStatus.APPLICATION_STATUSES.forEach(function zero(status) {
      counts[status] = 0;
    });
    return counts;
  }
  function submitted(counts) {
    return applicationStatus.APPLICATION_STATUSES.reduce(function sum(total, status) {
      return status === "draft" ? total : total + counts[status];
    }, 0);
  }

  var perRound = {};
  var byStatus = emptyStatuses();
  rows.forEach(function add(row) {
    var key = row.round ? String(row.round) : "none";
    perRound[key] = perRound[key] || emptyStatuses();
    perRound[key][row.status] = (perRound[key][row.status] || 0) + row.count;
    if (!scope.round || scope.round === key) {
      byStatus[row.status] = (byStatus[row.status] || 0) + row.count;
    }
  });

  var byRound = rounds.map(function toRow(round) {
    var counts = perRound[String(round._id)] || emptyStatuses();
    return { _id: round._id, name: round.name, total: submitted(counts), byStatus: counts };
  });
  if (perRound.none) {
    byRound.push({ _id: null, name: "No round", total: submitted(perRound.none), byStatus: perRound.none });
  }

  return {
    total: scope.status ? byStatus[scope.status] || 0 : submitted(byStatus),
    byStatus: byStatus,
    byRound: byRound,
  };
}

/**
 * Group per-day, per-status rows into one row per day (zero-filled).
 * @param {Array<{date: string, status: string, count: number}>} rows - From countPerDay.
 * @returns {Array<object>} [{ date, total, byStatus: { status: n } }] in date order.
 */
function perDaySeries(rows) {
  function emptyDay(date) {
    var byStatus = {};
    applicationStatus.APPLICATION_STATUSES.forEach(function zero(status) {
      byStatus[status] = 0;
    });
    return { date: date, total: 0, byStatus: byStatus };
  }

  var days = {};
  rows.forEach(function add(row) {
    days[row.date] = days[row.date] || emptyDay(row.date);
    days[row.date].byStatus[row.status] = (days[row.date].byStatus[row.status] || 0) + row.count;
    days[row.date].total += row.count;
  });
  return statsUtil.fillDays(
    Object.keys(days).map(function toDay(date) {
      return days[date];
    }),
    emptyDay
  );
}

/**
 * The event-day figures: arrivals, meals served. (Workshop attendance and
 * hardware checkouts arrive with those modules; until then they are null.)
 * @returns {Promise<object>}
 */
function eventDayStats() {
  return Promise.all([
    Application.aggregate([
      { $match: { status: "accepted" } },
      { $group: { _id: "$applicant" } },
      { $group: { _id: null, count: { $sum: 1 } } },
    ]),
    CheckIn.countDocuments({}),
    CheckIn.countDocuments({ forced: true }),
    MealService.find({}).select("name startsAt active").sort({ startsAt: 1, createdAt: 1 }).lean(),
    MealCheckIn.countsByMeal(),
  ]).then(function toStats(results) {
    var served = results[4];
    var meals = results[3].map(function toMeal(meal) {
      return { _id: meal._id, name: meal.name, startsAt: meal.startsAt, active: meal.active, served: served[String(meal._id)] || 0 };
    });
    return {
      acceptedAttendees: results[0][0] ? results[0][0].count : 0,
      checkedIn: results[1],
      forcedCheckIns: results[2],
      mealsServed: meals.reduce(function sum(total, meal) {
        return total + meal.served;
      }, 0),
      meals: meals,
      workshopAttendance: null,
      hardwareOut: null,
    };
  });
}

/**
 * GET /api/admin/stats[?round=<id>][&status=<status>]
 *
 * Application and event-day statistics for the admin Statistics page. The
 * breakdowns (school, education level, gender, major, T-shirt size,
 * graduation year, custom questions, experience, submissions per day) cover
 * the submitted applications in scope: all of them, or one round and/or one
 * status. The status and round tables always cover every application.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getStats(req, res) {
  var scope = applicationScope.parseScope(req.query);
  if (scope.error) {
    res.status(400).json({ error: scope.error });
    return Promise.resolve();
  }

  return ApplicationRound.find({})
    .select("name formConfig")
    .sort({ order: 1, createdAt: 1 })
    .lean()
    .then(function afterRounds(rounds) {
      var formRounds = scope.round
        ? rounds.filter(function inScope(round) {
            return String(round._id) === scope.round;
          })
        : rounds;
      var questions = chartableQuestions(formRounds);

      return Promise.all([
        countByRoundAndStatus(),
        countByText(scope.match, "university"),
        countByText(scope.match, "education"),
        countByText(scope.match, "gender"),
        countByText(scope.match, "major"),
        countByText(scope.match, "tshirtSize"),
        countExperience(scope.match),
        countPerDay(scope.match),
        countAnswers(
          scope.match,
          questions.map(function toKey(question) {
            return question.key;
          })
        ),
        eventDayStats(),
      ]).then(function assemble(results) {
        var statuses = summarizeStatuses(results[0], rounds, scope);
        var answers = results[8];

        var charted = questions
          .map(function toChart(question) {
            var chart = statsUtil.bucketize(answers[question.key] || [], TOP_SMALL);
            return Object.assign({ key: question.key, label: question.label, type: question.type, graduation: question.graduation }, chart);
          })
          .filter(function hasAnswers(chart) {
            return chart.total > 0;
          });
        var graduation = charted.filter(function isGraduation(chart) {
          return chart.graduation;
        })[0];

        res.status(200).json({
          generatedAt: new Date().toISOString(),
          timeZone: calendar.eventTimeZone(),
          filters: { round: scope.round || null, status: scope.status || null },
          applications: {
            total: statuses.total,
            byStatus: statuses.byStatus,
            byRound: statuses.byRound,
            bySchool: statsUtil.bucketize(results[1], TOP_SCHOOLS),
            byEducation: statsUtil.bucketize(results[2], TOP_SMALL),
            byGender: statsUtil.bucketize(results[3], TOP_SMALL),
            byMajor: statsUtil.bucketize(results[4], TOP_MAJORS),
            byTshirtSize: statsUtil.bucketize(results[5], TOP_SMALL),
            byGraduationYear: graduation ? pickChart(graduation) : null,
            experience: results[6],
            submissionsPerDay: perDaySeries(results[7]),
            questions: charted
              .filter(function notGraduation(chart) {
                return !chart.graduation;
              })
              .map(pickChart),
          },
          eventDay: results[9],
        });
      });
    })
    .catch(function onError(err) {
      console.error("getStats failed:", err);
      res.status(500).json({ error: "Could not load the statistics." });
    });
}

/**
 * A charted question without the internal `graduation` marker.
 * @param {object} chart - Bucketized question.
 * @returns {object}
 */
function pickChart(chart) {
  var copy = Object.assign({}, chart);
  delete copy.graduation;
  return copy;
}

module.exports = {
  getStats: getStats,
};
