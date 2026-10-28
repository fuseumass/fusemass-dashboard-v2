"use strict";
var crypto = require("crypto");
var mongoose = require("mongoose");
var Project = require("../schemas/project");
var Room = require("../schemas/judgingRoom");
var Table = require("../schemas/judgingTable");
var User = require("../schemas/user");
var resolveAttendee = require("./staffController").resolveAttendee;
var tables = require("../utils/judging/tables");
var mailer = require("../utils/mailer");
var qr = require("../utils/qrCode");
function fail(res, err) {
  console.error("Judging check-in:", err);
  return res.status(err.status || 500).json({ error: err.status ? err.message : "Could not complete judging check-in. Try again." });
}
function email(project) {
  Promise.all([User.find({ _id: { $in: project.members } }).select("name email"), Room.findById(project.room)])
    .then(function send(results) {
      return Promise.all(results[0].map(function member(user) {
        return mailer.sendTemplateEmail(user.email, "judging_table_assigned", { name: user.name, table: project.tableNumber, room: results[1].name }, { userId: user._id });
      }));
    }).catch(function failed(err) { console.error("Table assignment email:", err); });
}
async function participant(req, res) {
  var user = await User.findById(req.user.id).select("role");
  if (!user || user.role === "judge") { res.status(403).json({ error: "Accepted participants only." }); return null; }
  var found = await resolveAttendee({ userId: req.user.id });
  if (found.error) { res.status(403).json({ error: found.error }); return null; }
  return found.user;
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function deskCheckin(req, res) {
  try {
    var found = await resolveAttendee(req.body);
    if (found.error) return res.status(found.status).json({ error: found.error });
    if (found.user.role === "judge") return res.status(403).json({ error: "Accepted participants only." });
    var projects = await Project.find({ members: found.user._id, withdrawn: false });
    var id = req.body.projectId;
    if (!projects.length) return res.status(404).json({ error: "No project found for this attendee." });
    if (!id && projects.length > 1) return res.status(409).json({ error: "Choose a project.", projects: projects.map(function summary(p) { return { _id: p._id, name: p.name }; }) });
    var project = projects.find(function match(p) { return !id || String(p._id) === String(id); });
    if (!project) return res.status(400).json({ error: "Choose one of this attendee's projects." });
    var result = await tables.assign(project._id, false);
    if (result.changed) email(result.project);
    await result.project.populate("room", "name");
    await result.project.populate("members", "name email");
    res.json({ project: result.project, alreadyAssigned: !result.changed });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function myProjects(req, res) {
  try {
    if (!await participant(req, res)) return;
    res.json({ projects: await Project.find({ members: req.user.id, withdrawn: false }).select("name room tableNumber deskCheckedInAt tableCheckedInAt").populate("room", "name") });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function tableCheckin(req, res) {
  try {
    if (!await participant(req, res)) return;
    var token = req.body && req.body.token;
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ error: "Invalid table QR code." });
    var table = await Table.findOne({ token: token });
    if (!table) return res.status(400).json({ error: "Invalid table QR code." });
    var projects = await Project.find({ members: req.user.id, withdrawn: false }).populate("room", "name");
    var assigned = projects.filter(function ready(p) { return p.deskCheckedInAt && p.tableNumber; });
    if (!assigned.length) return res.status(409).json({ error: "Check in at the judging desk first." });
    var project = assigned.find(function match(p) { return p.tableNumber === table.number && String(p.room._id) === String(table.room); });
    if (!project) return res.status(409).json({ error: "Wrong table: you're at table " + table.number + ", go to table " + assigned[0].tableNumber + " in " + assigned[0].room.name });
    await Project.updateOne({ _id: project._id, tableNumber: table.number, deskCheckedInAt: { $ne: null }, tableCheckedInAt: null, withdrawn: false, members: req.user.id }, { $set: { tableCheckedInAt: new Date() } });
    var latest = await Project.findById(project._id).select("name room tableNumber deskCheckedInAt tableCheckedInAt").populate("room", "name");
    if (!latest || latest.tableNumber !== table.number || !latest.tableCheckedInAt) return res.status(409).json({ error: "Your assignment changed. Check in at the judging desk again." });
    res.json({ project: latest });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function tableSigns(req, res) {
  try {
    var rooms = await Room.find({}).sort({ order: 1, name: 1, _id: 1 }).lean();
    var signs = [];
    for (var slot of tables.layout(rooms)) {
      var table;
      try {
        table = await Table.findOneAndUpdate({ number: slot.number }, { $setOnInsert: { token: crypto.randomBytes(32).toString("hex") }, $set: { room: slot.room } }, { upsert: true, new: true }).select("+token");
      } catch (err) {
        if (err.code !== 11000) throw err;
        table = await Table.findOne({ number: slot.number }).select("+token");
      }
      signs.push({ tableNumber: slot.number, room: rooms.find(function match(r) { return String(r._id) === String(slot.room); }).name, qr: await qr.toDataUrl(table.token) });
    }
    res.json({ signs: signs });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function bulkAssign(req, res) {
  try {
    var projects = await Project.find({ withdrawn: false, $or: [{ deskCheckedInAt: null }, { tableCheckedInAt: null }] }).sort({ _id: 1 });
    if (req.body.confirm !== true || req.body.count !== projects.length) return res.status(409).json({ error: "Confirm assigning and completing both check-ins for " + projects.length + " projects.", count: projects.length });
    var completed = [];
    for (var project of projects) {
      var result = await tables.assign(project._id, true);
      completed.push(project._id);
      if (result.changed) email(result.project);
    }
    res.json({ count: completed.length });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function undo(req, res) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Project not found." });
    var project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found." });
    if (project.tableNumber) await Project.updateOne({ _id: project._id, tableNumber: project.tableNumber }, { $push: { tableUndoLog: { by: req.user.id, at: new Date(), tableNumber: project.tableNumber, room: project.room } }, $unset: { room: 1, tableNumber: 1, deskCheckedInAt: 1, tableCheckedInAt: 1 } });
    res.json({ cleared: true });
  } catch (err) { fail(res, err); }
}
module.exports = { deskCheckin: deskCheckin, myProjects: myProjects, tableCheckin: tableCheckin, tableSigns: tableSigns, bulkAssign: bulkAssign, undo: undo };
