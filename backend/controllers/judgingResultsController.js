"use strict";
var Project = require("../schemas/project");
var Score = require("../schemas/judgingScore");
var Profile = require("../schemas/judgeProfile");
var User = require("../schemas/user");
var State = require("../schemas/judgingState");
var Assignment = require("../schemas/judgingAssignment");
var Settings = require("../schemas/judgingSettings");
var computeResults = require("../utils/judging/results").computeResults;
var csv = require("../utils/csv");

async function load() {
  var data = await Promise.all([
    Project.find({}).select("name category tableNumber withdrawn devpostUrl hardware team room").populate("team", "name").populate("room", "name").lean(),
    Score.find({}).lean(), Profile.find({}).select("user bias").lean(),
    User.find({}).select("name email").lean(), State.findById("judging").lean(), Settings.getSingleton(),
  ]);
  var assignment = data[4] && data[4].activeVersion ? await Assignment.findOne({ version: data[4].activeVersion }).lean() : null;
  return { projects: data[0], scores: data[1], profiles: data[2], users: data[3], assignment: assignment,
    criteria: data[5].criteria, judgingOpen: data[5].judgingOpen };
}
function progressData(data) {
  var active = data.projects.filter(function active(p) { return !p.withdrawn; });
  var ids = new Set(active.map(function id(p) { return String(p._id); }));
  var pairs = new Set(data.scores.map(function pair(s) { return String(s.judge) + ":" + String(s.project); }));
  var projects = active.map(function project(p) { return Object.assign({}, p, { scoresIn: 0, assigned: 0 }); });
  var judges = (data.assignment ? data.assignment.queues : []).map(function queue(q) {
    var user = data.users.find(function same(u) { return String(u._id) === String(q.judge); });
    var assigned = Array.from(new Set(q.projects.map(String))).filter(function exists(id) { return ids.has(id); });
    var done = 0;
    assigned.forEach(function count(id) {
      var p = projects.find(function same(p) { return String(p._id) === id; });
      p.assigned++;
      if (pairs.has(String(q.judge) + ":" + id)) { p.scoresIn++; done++; }
    });
    return { _id: String(q.judge), name: user ? user.name : "Removed judge", email: user ? user.email : "", done: done, total: assigned.length };
  });
  var expected = data.assignment ? data.assignment.params.judgingsPerProject : 3;
  projects.forEach(function missing(p) { p.missingScores = p.scoresIn < Math.max(p.assigned, expected); });
  projects.sort(function order(a, b) { return Number(b.missingScores) - Number(a.missingScores) || (a.tableNumber || Infinity) - (b.tableNumber || Infinity); });
  return { activeVersion: data.assignment ? data.assignment.version : null, judgingOpen: data.judgingOpen,
    judgingsPerProject: expected, projects: projects, judges: judges,
    missingProjects: projects.filter(function missing(p) { return p.missingScores; }) };
}
function resultsData(data) {
  var biases = Object.fromEntries(data.profiles.map(function bias(p) { return [String(p.user), p.bias]; }));
  return computeResults(data.projects, data.scores, data.criteria, biases, data.assignment ? data.assignment.params.judgingsPerProject : 3);
}
function fail(res, err) {
  console.error("Judging reports:", err);
  res.status(500).json({ error: "Could not load judging reports. Try again." });
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function progress(req, res) {
  try { res.set("Cache-Control", "no-store").json(progressData(await load())); } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function results(req, res) {
  try { var data = await load(); res.set("Cache-Control", "no-store").json({ results: resultsData(data), judgingOpen: data.judgingOpen }); } catch (err) { fail(res, err); }
}
/** @param {object} req - Request with export kind in route path. @param {object} res - Response. @returns {Promise<void>} */
async function exportCsv(req, res) {
  try {
    var data = await load();
    var kind = req.path.split("/").pop().replace(".csv", "");
    var header;
    var rows;
    if (kind === "progress") {
      header = ["Judge", "Email", "Done", "Total", "Active version"];
      rows = progressData(data).judges.map(function row(j) { return [j.name, j.email, j.done, j.total, data.assignment.version]; });
    } else if (kind === "results") {
      header = ["Project", "Table", "Category", "Withdrawn", "Scores", "Raw general", "Adjusted general", "Raw category", "Adjusted category", "Overall rank", "Category rank", "Missing scores", "No calibration"];
      rows = resultsData(data).map(function row(p) { return [p.name, p.tableNumber, p.category, p.withdrawn, p.scoreCount, p.rawGeneral, p.adjustedGeneral, p.rawCategory, p.adjustedCategory, p.overallRank, p.categoryRank, p.flags.missingScores, p.flags.noCalibration]; });
    } else {
      header = ["Judge", "Email", "Project", "Table"].concat(data.criteria.map(function label(c) { return c.label; }), ["Comments", "Time"]);
      rows = data.scores.map(function row(s) {
        var judge = data.users.find(function same(u) { return String(u._id) === String(s.judge); });
        var project = data.projects.find(function same(p) { return String(p._id) === String(s.project); });
        return [judge ? judge.name : "Removed judge", judge ? judge.email : "", project ? project.name : "Removed project", project && project.tableNumber]
          .concat(data.criteria.map(function value(c) { return s.scores[c.key]; }), [s.comments, s.updatedAt]);
      });
    }
    var offset = 0;
    await csv.sendCsv(res, { filename: csv.datedFilename("judging-" + kind, "csv"), header: header,
      nextRows: async function nextRows() { var batch = rows.slice(offset, offset + 250); offset += batch.length; return batch; } });
  } catch (err) { fail(res, err); }
}
/**
 * One project in full for the results page: what was imported, its table,
 * every judge's raw criterion scores and comments, their calibration bias and
 * the bias-adjusted totals that feed the ranking, plus who is still to judge.
 * @param {object} req - Request (params.id). @param {object} res - Response. @returns {Promise<void>}
 */
async function projectDetail(req, res) {
  try {
    var mongoose = require("mongoose");
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Project not found." });
    var project = await Project.findById(req.params.id)
      .populate("room", "name")
      .populate("members", "name")
      .populate({ path: "team", select: "name leader", populate: { path: "leader", select: "name" } })
      .lean();
    if (!project) return res.status(404).json({ error: "Project not found." });
    var data = await load();
    var summary = resultsData(data).find(function same(r) { return r._id === String(project._id); }) || null;
    var weights = { general: 0, category: 0 };
    data.criteria.forEach(function weigh(c) { weights[c.kind === "general" ? "general" : "category"] += c.weight; });
    function userOf(id) { return data.users.find(function same(u) { return String(u._id) === String(id); }); }
    var hardwareJudges = new Set((await Profile.find({ hardware: true }).select("user").lean()).map(function id(p) { return String(p.user); }));
    var scores = data.scores.filter(function mine(s) { return String(s.project) === String(project._id); }).map(function row(s) {
      var general = 0;
      var category = 0;
      data.criteria.forEach(function add(c) {
        var value = s.scores[c.key];
        if (c.kind === "general") general += value * c.weight;
        else category += value * c.weight;
      });
      var profile = data.profiles.find(function same(p) { return String(p.user) === String(s.judge); });
      var bias = profile && profile.bias && Number.isFinite(profile.bias.general) && Number.isFinite(profile.bias.category) ? profile.bias : null;
      var judge = userOf(s.judge);
      return {
        judgeId: String(s.judge), judge: judge ? judge.name : "Removed judge", hardwareJudge: hardwareJudges.has(String(s.judge)),
        scores: s.scores, comments: s.comments || "", updatedAt: s.updatedAt,
        rawGeneral: general, rawCategory: category,
        bias: bias ? { general: bias.general, category: bias.category } : null,
        adjustedGeneral: general - (bias ? bias.general * weights.general : 0),
        adjustedCategory: category - (bias ? bias.category * weights.category : 0),
      };
    }).sort(function when(a, b) { return new Date(a.updatedAt) - new Date(b.updatedAt); });
    var scoredBy = new Set(scores.map(function id(s) { return s.judgeId; }));
    var assigned = (data.assignment ? data.assignment.queues : []).filter(function has(q) {
      return q.projects.some(function same(p) { return String(p) === String(project._id); });
    }).map(function judge(q) {
      var user = userOf(q.judge);
      var id = String(q.judge);
      var status = scoredBy.has(id) ? "scored" : (q.skipped || []).some(function same(p) { return String(p) === String(project._id); }) ? "skipped" : "pending";
      var position = q.projects.findIndex(function same(p) { return String(p) === String(project._id); }) + 1;
      return { judgeId: id, judge: user ? user.name : "Removed judge", hardwareJudge: hardwareJudges.has(id), status: status, position: position, queueLength: q.projects.length };
    });
    res.set("Cache-Control", "no-store").json({
      project: {
        _id: String(project._id), name: project.name, devpostUrl: project.devpostUrl, category: project.category || "",
        optInPrizes: project.optInPrizes || [], mlhTracks: project.mlhTracks || [], hardware: Boolean(project.hardware),
        needsPower: Boolean(project.needsPower), withdrawn: Boolean(project.withdrawn),
        tableNumber: project.tableNumber || null, room: project.room ? project.room.name : null,
        team: project.team ? project.team.name : null, leader: project.team && project.team.leader ? project.team.leader.name : null,
        members: (project.members || []).map(function name(m) { return m.name; }),
        unmatchedMembers: project.unmatchedMembers || [],
        deskCheckedInAt: project.deskCheckedInAt || null, tableCheckedInAt: project.tableCheckedInAt || null,
      },
      criteria: data.criteria.map(function c(x) { return { key: x.key, label: x.label, kind: x.kind, min: x.min, max: x.max, weight: x.weight }; }),
      weights: weights,
      summary: summary,
      judgingsPerProject: data.assignment ? data.assignment.params.judgingsPerProject : null,
      scores: scores,
      assigned: assigned,
    });
  } catch (err) { fail(res, err); }
}
/**
 * Ranked results as CSV: overall (by adjusted general total), one category
 * (?category=<name>, by adjusted category total) or every category grouped
 * (?category=all). Unranked projects (no scores or withdrawn) come last.
 * @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>}
 */
async function rankingCsv(req, res) {
  try {
    var data = await load();
    var byId = new Map(data.projects.map(function entry(p) { return [String(p._id), p]; }));
    var rows = resultsData(data);
    var wanted = req.query.category;
    if (wanted !== undefined && typeof wanted !== "string") return res.status(400).json({ error: "Invalid category." });
    var categories = Array.from(new Set(rows.map(function c(r) { return r.category; }))).sort();
    if (wanted && wanted !== "all" && !categories.includes(wanted)) return res.status(404).json({ error: "No projects in that category." });
    function ordered(list, rankKey) {
      return list.slice().sort(function order(a, b) {
        return (a[rankKey] || Infinity) - (b[rankKey] || Infinity) || String(a.name).localeCompare(String(b.name));
      });
    }
    function line(ranking, rankKey, r) {
      var p = byId.get(r._id) || {};
      return [ranking, r[rankKey] || "", r.name, r.tableNumber || "", p.room ? p.room.name : "", r.category || "Uncategorized",
        p.devpostUrl || "", p.team ? p.team.name : "", Boolean(p.hardware), r.scoreCount,
        r.adjustedGeneral, r.rawGeneral, r.adjustedCategory, r.rawCategory,
        r.flags.missingScores, r.flags.noCalibration, r.withdrawn];
    }
    var out = [];
    var name;
    if (!wanted) {
      name = "overall";
      ordered(rows, "overallRank").forEach(function add(r) { out.push(line("Overall", "overallRank", r)); });
    } else {
      name = wanted === "all" ? "by-category" : wanted.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "category";
      (wanted === "all" ? categories : [wanted]).forEach(function each(category) {
        ordered(rows.filter(function same(r) { return r.category === category; }), "categoryRank")
          .forEach(function add(r) { out.push(line(category || "Uncategorized", "categoryRank", r)); });
      });
    }
    var header = ["Ranking", "Rank", "Project", "Table", "Room", "Category", "Devpost URL", "Team", "Hardware", "Scores",
      "Adjusted general", "Raw general", "Adjusted category", "Raw category", "Too few scores", "Uncalibrated judge", "Withdrawn"];
    var offset = 0;
    await csv.sendCsv(res, { filename: csv.datedFilename("judging-ranking-" + name, "csv"), header: header,
      nextRows: async function nextRows() { var batch = out.slice(offset, offset + 250); offset += batch.length; return batch; } });
  } catch (err) { fail(res, err); }
}
module.exports = { rankingCsv: rankingCsv, progress: progress, results: results, exportCsv: exportCsv, projectDetail: projectDetail };
