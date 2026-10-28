"use strict";
var Settings = require("../schemas/judgingSettings");
var Profile = require("../schemas/judgeProfile");
var User = require("../schemas/user");
var rubric = require("../utils/judging/rubric");
var computeBias = require("../utils/judging/bias").computeBias;
function fail(res) {
  res.status(500).json({ error: "Could not save calibration. Try again." });
}
function text(value, max) {
  return typeof value === "string" && value.length <= max;
}
function validProjects(rows) {
  return (
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.length <= 20 &&
    rows.every(function valid(p) {
      if (
        !p ||
        !text(p.title, 200) ||
        !p.title.trim() ||
        (p.description !== undefined && !text(p.description, 5000))
      )
        return false;
      if (!p.link) return p.link === undefined || p.link === "";
      try {
        return text(p.link, 2000) && new URL(p.link).protocol === "https:";
      } catch (err) {
        return false;
      }
    })
  );
}
function validCriteria(rows) {
  return (
    Array.isArray(rows) &&
    rows.length >= 2 &&
    rows.length <= 30 &&
    new Set(
      rows.map(function key(c) {
        return c && c.key;
      }),
    ).size === rows.length &&
    rows.filter(function category(c) {
      return c && c.kind === "category";
    }).length === 1 &&
    rows.every(function valid(c) {
      return (
        c &&
        text(c.key, 60) &&
        /^[a-zA-Z][a-zA-Z0-9_]*$/.test(c.key) &&
        !["constructor", "prototype", "__proto__"].includes(c.key) &&
        text(c.label, 200) &&
        c.label.trim() &&
        text(c.help, 5000) &&
        Number.isInteger(c.min) &&
        Number.isInteger(c.max) &&
        c.min < c.max &&
        Number.isFinite(c.weight) &&
        c.weight > 0 &&
        ["general", "category"].includes(c.kind)
      );
    })
  );
}
/**
 * Whether saved calibration scores stop being valid: a different number of
 * rounds, or criteria with different keys, ranges or kinds. Wording, help
 * text, links and weights can change without wiping judges' work.
 * @param {object} before - Settings before the edit.
 * @param {object} after - Settings after the edit.
 * @returns {boolean}
 */
function scoringChanged(before, after) {
  function shape(settings) {
    return JSON.stringify({
      rounds: (settings.calibrationProjects || []).length,
      criteria: (settings.criteria || []).map(function core(c) {
        return [c.key, c.min, c.max, c.kind];
      }),
    });
  }
  return shape(before) !== shape(after);
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function getSettings(req, res) {
  try {
    res.json({ settings: await Settings.getSingleton() });
  } catch (err) {
    fail(res);
  }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function patchSettings(req, res) {
  var body = req.body || {};
  if (
    Object.keys(body).some(function unknown(k) {
      return !["criteria", "calibrationProjects", "judgingOpen"].includes(k);
    }) ||
    (body.criteria !== undefined && !validCriteria(body.criteria)) ||
    (body.calibrationProjects !== undefined &&
      !validProjects(body.calibrationProjects)) ||
    (body.judgingOpen !== undefined && typeof body.judgingOpen !== "boolean")
  ) {
    res.status(400).json({
      error:
        "Enter valid projects and criteria with unique keys, whole ranges, positive weights and exactly one category criterion.",
    });
    return;
  }
  try {
    var settings = await Settings.getSingleton();
    var configuration =
      body.criteria !== undefined || body.calibrationProjects !== undefined;
    if (configuration && (settings.judgingOpen || settings.criteriaLocked)) {
      res.status(409).json({
        error:
          "Calibration projects and criteria are locked after judging starts.",
      });
      return;
    }
    var before = settings.toObject();
    var changes = Object.assign({}, body);
    if (body.judgingOpen) {
      changes.criteriaLocked = true;
      if (!settings.judgingOpenedAt) changes.judgingOpenedAt = new Date();
    }
    // The conditional update prevents an editor racing with opening judging.
    var filter = { _id: settings._id, __v: settings.__v };
    if (configuration) {
      filter.judgingOpen = false;
      filter.criteriaLocked = false;
    }
    settings = await Settings.findOneAndUpdate(
      filter,
      { $set: changes, $inc: { __v: 1 } },
      { new: true },
    );
    if (!settings) {
      res
        .status(409)
        .json({ error: "Settings changed. Reload and try again." });
      return;
    }
    if (configuration && scoringChanged(before, settings))
      await Profile.updateMany(
        {},
        {
          $set: { calibrationScores: [], calibrationDone: false, bias: null },
          $inc: { __v: 1 },
        },
      );
    res.json({ settings: settings });
  } catch (err) {
    fail(res);
  }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function getCalibration(req, res) {
  try {
    var settings = await Settings.getSingleton();
    var profile = await Profile.findOne({ user: req.user.id });
    res.json({
      rounds: settings.calibrationProjects,
      criteria: settings.criteria,
      scores: profile ? profile.calibrationScores : [],
      calibrationDone: profile
        ? rubric.calibrationDone(profile, settings)
        : false,
    });
  } catch (err) {
    fail(res);
  }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function scoreRound(req, res) {
  try {
    var settings = await Settings.getSingleton();
    var round = Number(req.params.round);
    var body = req.body || {};
    if (
      !/^\d+$/.test(req.params.round) ||
      !Number.isInteger(round) ||
      round < 1 ||
      round > settings.calibrationProjects.length ||
      !rubric.validScores(body.scores, settings.criteria) ||
      (body.comments !== undefined && !text(body.comments, 5000))
    ) {
      res.status(400).json({
        error:
          "Score every criterion with an integer in its range and provide a valid round.",
      });
      return;
    }
    var profile = await Profile.findOne({ user: req.user.id });
    if (!profile || !profile.active) {
      res.status(403).json({ error: "An active judge profile is required." });
      return;
    }
    for (var previous = 1; previous < round; previous++) {
      if (
        !profile.calibrationScores.some(function scored(row) {
          return (
            row.round === previous &&
            rubric.validScores(row.scores, settings.criteria)
          );
        })
      ) {
        res.status(409).json({ error: "Score the earlier rounds first." });
        return;
      }
    }
    profile.calibrationScores = profile.calibrationScores.filter(
      function other(row) {
        return row.round !== round;
      },
    );
    profile.calibrationScores.push({
      round: round,
      scores: body.scores,
      comments: body.comments || "",
    });
    profile.calibrationScores.sort(function ordered(a, b) {
      return a.round - b.round;
    });
    profile.calibrationDone = rubric.calibrationDone(profile, settings);
    profile.bias = null;
    await profile.save();
    // Every participant's bias depends on the entire calibration cohort.
    await Profile.updateMany({}, { $set: { bias: null } });
    res.json({
      scores: profile.calibrationScores,
      calibrationDone: profile.calibrationDone,
    });
  } catch (err) {
    if (err.name === "VersionError") {
      res
        .status(409)
        .json({ error: "Calibration changed. Reload and try again." });
      return;
    }
    fail(res);
  }
}
async function biasRows(compute) {
  var settings = await Settings.getSingleton();
  var users = await User.find({ role: "judge" }).select("_id name").lean();
  var profiles = await Profile.find({
    user: {
      $in: users.map(function id(u) {
        return u._id;
      }),
    },
    active: true,
  });
  var scores = {};
  profiles.forEach(function collect(p) {
    if (rubric.calibrationDone(p, settings))
      scores[String(p.user)] = p.calibrationScores
        .slice()
        .sort(function order(a, b) {
          return a.round - b.round;
        })
        .map(function values(row) {
          return row.scores;
        });
  });
  if (compute) {
    var result = computeBias(scores, {
      general: settings.criteria
        .filter(function general(c) {
          return c.kind === "general";
        })
        .map(function key(c) {
          return c.key;
        }),
      category: settings.criteria.find(function category(c) {
        return c.kind === "category";
      }).key,
    });
    var now = new Date();
    await Profile.updateMany({}, { $set: { bias: null } });
    for (var p of profiles) {
      p.calibrationDone = rubric.calibrationDone(p, settings);
      p.bias = result[String(p.user)]
        ? Object.assign({}, result[String(p.user)], { computedAt: now })
        : null;
      await p.save();
    }
  }
  return users.map(function row(u) {
    var p = profiles.find(function match(p) {
      return String(p.user) === String(u._id);
    });
    return {
      id: u._id,
      name: u.name,
      done: !!p && rubric.calibrationDone(p, settings),
      bias: p ? p.bias : null,
    };
  });
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function getBias(req, res) {
  try {
    res.json({ judges: await biasRows(false) });
  } catch (err) {
    fail(res);
  }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function postBias(req, res) {
  try {
    res.json({ judges: await biasRows(true) });
  } catch (err) {
    fail(res);
  }
}
module.exports = {
  getSettings: getSettings,
  patchSettings: patchSettings,
  getCalibration: getCalibration,
  scoreRound: scoreRound,
  getBias: getBias,
  postBias: postBias,
};
