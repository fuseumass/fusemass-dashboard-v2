"use strict";
var mongoose = require("mongoose");
var Assignment = require("../schemas/judgingAssignment");
var Project = require("../schemas/project");
var Room = require("../schemas/judgingRoom");
var Profile = require("../schemas/judgeProfile");
var User = require("../schemas/user");
var State = require("../schemas/judgingState");
var control = require("../utils/judging/state");
var Settings = require("../schemas/judgingSettings");
var algorithm = require("../utils/judging/assignments");

function fail(res, err) {
  res.status(err.status || (err.code === 11000 ? 409 : 500)).json({ error: err.status ? err.message : "Could not update assignments. Retry." });
}
async function active(state) {
  var version = await Assignment.findOne({ version: state.activeVersion });
  if (!version) throw control.problem(409, "Activate an assignment version first.");
  return version;
}
/**
 * Give every judge in a version a stable anonymous label ("Judge 3") for the
 * participant judging sheet. Runs where queues change (activation, late
 * additions), under the judging lock, so the sheet itself never writes.
 * @param {object} assignment - JudgingAssignment document (mutated).
 * @returns {void}
 */
function labelJudges(assignment) {
  assignment.queues.forEach(function label(q) {
    if (!assignment.sheetLabels.some(function same(entry) { return String(entry.judge) === String(q.judge); })) {
      assignment.sheetLabels.push({ judge: q.judge, label: "Judge " + (assignment.sheetLabels.length + 1) });
    }
  });
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function generate(req, res) {
  var body = req.body || {};
  var count = body.judgingsPerProject === undefined ? 3 : body.judgingsPerProject;
  var minutes = body.slotMinutes == null ? null : body.slotMinutes;
  if (!Number.isInteger(count) || count < 1 || count > 100 ||
      (minutes !== null && (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0 || minutes > 240))) {
    return res.status(400).json({ error: "Use 1 to 100 judgings per project and a positive slot duration up to 240 minutes, or null." });
  }
  try {
    var result = await control.locked(async function build() {
      var projects = await Project.find({ withdrawn: false, deskCheckedInAt: { $ne: null }, tableCheckedInAt: { $ne: null }, tableNumber: { $gt: 0 } }).sort({ tableNumber: 1 }).lean();
      var rooms = await Room.find({}).sort({ order: 1, name: 1, _id: 1 }).lean();
      var profiles = await Profile.find({ active: true }).populate({ path: "user", select: "role" }).lean();
      profiles = profiles.filter(function eligible(p) { return p.user && ["judge", "admin"].includes(p.user.role); });
      var queues = [];
      var reports = [];
      for (var hardware of [false, true]) {
        var pool = projects.filter(function match(p) { return p.hardware === hardware; });
        if (!pool.length) continue;
        // Hardware judges have their own pool, avoiding simultaneous visits in
        // independently generated schedules and matching the original flow.
        var judges = profiles.filter(function match(p) { return p.hardware === hardware; });
        var poolRooms = rooms.filter(function match(r) { return r.hardware === hardware && r.capacity > 0; });
        var report;
        try {
          if (judges.length < count) throw new Error("Not enough eligible judges for this pool.");
          if (!poolRooms.length) throw new Error("No rooms configured for this pool.");
          if (pool.some(function wrongRoom(p) { return !poolRooms.some(function same(r) { return String(r._id) === String(p.room); }); })) throw new Error("A project is outside its room pool.");
          var byTable = new Map(pool.map(function entry(p) { return [p.tableNumber, p]; }));
          var roomTables = poolRooms.map(function tables(room) {
            return pool.filter(function member(p) { return String(p.room) === String(room._id); })
              .map(function number(p) { return p.tableNumber; });
          });
          report = algorithm.generateJudgingAssignments({
            teams: pool.map(function team(p) { return { name: p.name, tableNumber: p.tableNumber }; }),
            judges: judges.map(function judge(p) { return { name: String(p.user._id) }; }),
            judgingsPerProject: count, numRooms: poolRooms.length,
            roomCapacities: poolRooms.map(function capacity(r) { return r.capacity; }), roomTables: roomTables,
          });
          if (report.success) {
            report.assignments.forEach(function queue(row, i) {
              queues.push({ judge: judges[i].user._id,
                projects: row.assignments.map(function project(n) { return byTable.get(n)._id; }),
                slots: row.slots.map(function slot(n) { return n === -1 ? null : byTable.get(n)._id; }), skipped: [] });
            });
          }
        } catch (err) { report = { success: false, issues: [err.message], log: [] }; }
        reports.push({ pool: hardware ? "hardware" : "regular", success: report.success, issues: report.issues, log: report.log,
          rooms: poolRooms.map(function room(r) { return { id: r._id, capacity: r.capacity }; }) });
      }
      if (!projects.length) reports.push({ pool: "all", success: false, issues: ["No projects have completed both check-ins."], log: [] });
      if (reports.some(function failed(r) { return !r.success; })) return { error: "Assignment verification failed. Nothing was saved.", verifierReport: reports };
      var last = await Assignment.findOne({}).sort({ version: -1 }).select("version").lean();
      var assignment = await Assignment.create({ version: last ? last.version + 1 : 1, createdBy: req.user.id,
        params: { judgingsPerProject: count, slotMinutes: minutes }, verifierReport: reports, queues: queues });
      return { assignment: assignment, verifierReport: reports };
    });
    res.status(result.assignment ? 201 : 422).json(result);
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function list(req, res) {
  try {
    var state = await control.getState();
    res.json({ versions: await Assignment.find({}).sort({ version: -1 }).lean(), activeVersion: state.activeVersion, judgingOpen: state.judgingOpen });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function activate(req, res) {
  try {
    var result = await control.locked(async function change() {
      var version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) throw control.problem(404, "Version not found.");
      var assignment = await Assignment.findOne({ version: version });
      if (!assignment) throw control.problem(404, "Version not found.");
      // Never revive withdrawn projects or removed/demoted judges on activation.
      var projects = await Project.distinct("_id", { withdrawn: false });
      var users = await User.distinct("_id", { role: { $in: ["judge", "admin"] } });
      var profiles = await Profile.distinct("user", { active: true });
      var allowedProjects = new Set(projects.map(String));
      var allowedUsers = new Set(users.map(String).filter(function profiled(id) { return profiles.some(function same(p) { return String(p) === id; }); }));
      assignment.queues = assignment.queues.filter(function eligible(q) { return allowedUsers.has(String(q.judge)); });
      assignment.queues.forEach(function prune(q) {
        q.projects = q.projects.filter(function allowed(p) { return allowedProjects.has(String(p)); });
        q.slots = q.slots.map(function allowed(p) { return p && allowedProjects.has(String(p)) ? p : null; });
        q.skipped = q.skipped.filter(function allowed(p) { return allowedProjects.has(String(p)); });
      });
      labelJudges(assignment);
      await assignment.save();
      await State.updateOne({ _id: "judging" }, { $set: { activeVersion: version } });
      return { activeVersion: version };
    });
    res.json(result);
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request containing judgeId and projectIds. @param {object} res - Response. @returns {Promise<void>} */
async function addJudge(req, res) {
  try {
    var body = req.body || {};
    if (!mongoose.isValidObjectId(body.judgeId) || !Array.isArray(body.projectIds) || !body.projectIds.length || body.projectIds.some(function invalid(id) { return !mongoose.isValidObjectId(id); }) || new Set(body.projectIds.map(String)).size !== body.projectIds.length) throw control.problem(400, "Choose a judge and distinct projects.");
    body = { judgeId: String(new mongoose.Types.ObjectId(body.judgeId)), projectIds: body.projectIds.map(function normalize(id) { return String(new mongoose.Types.ObjectId(id)); }) };
    if (new Set(body.projectIds).size !== body.projectIds.length) throw control.problem(400, "Choose distinct projects.");
    await control.locked(async function add(state) {
      var assignment = await active(state);
      var profile = await Profile.findOne({ user: body.judgeId, active: true }).populate({ path: "user", select: "role" });
      if (!profile || !profile.user || !["judge", "admin"].includes(profile.user.role)) throw control.problem(404, "Active judge not found.");
      if (assignment.queues.some(function same(q) { return String(q.judge) === body.judgeId; })) throw control.problem(409, "Judge already has a queue. Remove it before replacing it.");
      var projects = await Project.find({ _id: { $in: body.projectIds }, withdrawn: false, deskCheckedInAt: { $ne: null }, tableCheckedInAt: { $ne: null }, tableNumber: { $gt: 0 } });
      if (projects.length !== body.projectIds.length) throw control.problem(400, "All projects must have completed both check-ins.");
      if (projects.some(function hardware(p) { return p.hardware && !profile.hardware; })) throw control.problem(400, "Hardware projects require a hardware judge.");
      // Append after existing slots: late judges cannot collide with the schedule.
      var offset = Math.max(0, ...assignment.queues.map(function length(q) { return q.slots.length; }));
      assignment.queues.push({ judge: body.judgeId, projects: body.projectIds, skipped: [], slots: Array(offset).fill(null).concat(body.projectIds) });
      labelJudges(assignment);
      await assignment.save();
    });
    res.json({ updated: true });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function removeJudge(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.judgeId)) throw control.problem(404, "Judge not found.");
    await control.removeJudge(req.params.judgeId);
    res.json({ updated: true });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function withdraw(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw control.problem(404, "Project not found.");
    await control.locked(async function change(state) {
      var project = await Project.findByIdAndUpdate(req.params.id, { $set: { withdrawn: true }, $addToSet: { overriddenFields: "withdrawn" } });
      if (!project) throw control.problem(404, "Project not found.");
      await control.removeProject(project._id, state);
    });
    res.json({ updated: true });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function setOpen(req, res) {
  try {
    var open = req.route.path === "/open";
    await control.locked(async function change() {
      // Opening judging also locks the rubric and calibration setup for good.
      var changes = open ? { judgingOpen: true, criteriaLocked: true } : { judgingOpen: false };
      // Plain updates (no aggregation pipeline) so this runs the same on Cosmos.
      await Settings.updateOne({ key: "default" }, { $set: changes, $inc: { __v: 1 } }, { upsert: true });
      // Keep the first opening time for schedule estimates; reopening keeps it.
      if (open) await Settings.updateOne({ key: "default", judgingOpenedAt: null }, { $set: { judgingOpenedAt: new Date() } });
    });
    res.json({ judgingOpen: open });
  } catch (err) { fail(res, err); }
}
module.exports = { generate: generate, list: list, activate: activate, addJudge: addJudge, removeJudge: removeJudge, withdraw: withdraw, setOpen: setOpen };
