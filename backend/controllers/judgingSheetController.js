"use strict";
var Team = require("../schemas/team");
var User = require("../schemas/user");
var Application = require("../schemas/application");
var Project = require("../schemas/project");
var Room = require("../schemas/judgingRoom");
var Assignment = require("../schemas/judgingAssignment");
var Score = require("../schemas/judgingScore");
var control = require("../utils/judging/state");
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function sheet(req, res) {
  res.set("Cache-Control", "no-store");
  try {
    var user = await User.findById(req.user.id).select("role").lean();
    if (!user || user.role === "judge" || (user.role !== "admin" && user.role !== "moderator" && !await Application.exists({ applicant: req.user.id, status: "accepted" }))) return res.status(403).json({ error: "Accepted participants and staff only." });
    var state = await control.getState();
    if (!state.judgingOpen) return res.json({ open: false });
    // Read-only: participants poll this, so it must never take the judging
    // lock that score writes use. Labels are assigned when queues change.
    var assignment = state.activeVersion ? await Assignment.findOne({ version: state.activeVersion }).lean() : null;
    var rooms = await Room.find({}).sort({ order: 1, name: 1, _id: 1 }).lean();
    var projects = await Project.find({ withdrawn: false }).select("team members room tableNumber").lean();
    var byId = new Map(projects.map(function entry(p) { return [String(p._id), p]; }));
    var scores = await Score.find({}).select("judge project").lean();
    var done = new Set(scores.map(function pair(s) { return String(s.judge) + ":" + String(s.project); }));
    var queues = assignment ? assignment.queues : [];
    var judges = await User.find({ _id: { $in: queues.map(function id(q) { return q.judge; }) }, role: { $in: ["judge", "admin"] } }).select("_id").lean();
    var active = new Set(judges.map(function id(j) { return String(j._id); }));
    var roomViews = rooms.map(function room(r) { return { name: r.name, hardware: r.hardware, judgeCount: 0, judges: [] }; });
    queues.forEach(function current(q) {
      if (!active.has(String(q.judge))) return;
      var skipped = new Set((q.skipped || []).map(String));
      var id = q.projects.find(function pending(id) { return byId.has(String(id)) && !skipped.has(String(id)) && !done.has(String(q.judge) + ":" + String(id)); });
      var project = byId.get(String(id));
      if (!project || !project.tableNumber) return;
      // Saved ordinal labels survive movement and queue removals.
      var roomIndex = rooms.findIndex(function same(r) { return String(r._id) === String(project.room); });
      if (roomIndex < 0) return;
      var named = (assignment.sheetLabels || []).find(function same(entry) { return String(entry.judge) === String(q.judge); });
      roomViews[roomIndex].judges.push({ label: named ? named.label : "Judge", table: project.tableNumber });
      roomViews[roomIndex].judgeCount++;
    });
    var team = await Team.findOne({ members: req.user.id }).select("_id").lean();
    var own = team ? projects.find(function mine(p) { return String(p.team) === String(team._id); }) : null;
    var ownTeam = null;
    if (own) {
      var assigned = queues.filter(function includes(q) { return active.has(String(q.judge)) && q.projects.some(function same(p) { return String(p) === String(own._id); }); });
      var completed = assigned.filter(function scored(q) { return done.has(String(q.judge) + ":" + String(own._id)); }).length;
      var room = rooms.find(function same(r) { return String(r._id) === String(own.room); });
      ownTeam = { table: own.tableNumber || null, room: room ? room.name : null, done: completed, assigned: assigned.length };
    }
    res.json({ open: true, software: roomViews.filter(function software(r) { return !r.hardware; }).map(clean), hardware: roomViews.filter(function hardware(r) { return r.hardware; }).map(clean), ownTeam: ownTeam });
  } catch (err) {
    res.status(500).json({ error: "Could not load the judging sheet. Try again." });
  }
}
function clean(room) { return { name: room.name, judgeCount: room.judgeCount, judges: room.judges }; }
module.exports = { sheet: sheet };
