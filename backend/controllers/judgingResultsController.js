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
    Project.find({}).select("name category tableNumber withdrawn").lean(),
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
module.exports = { progress: progress, results: results, exportCsv: exportCsv };
