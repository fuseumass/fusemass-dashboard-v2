"use strict";
var mongoose = require("mongoose");
var validator = require("validator");
var Team = require("../schemas/team");
var Project = require("../schemas/project");
var User = require("../schemas/user");
var Settings = require("../schemas/orgSettings");
var control = require("../utils/judging/state");
var resolveAttendee = require("./staffController").resolveAttendee;
var hardwareTeamChange = require("../utils/hardwareTeamChange");
var mailer = require("../utils/mailer");
var origin = require("../utils/clientOrigin").primaryClientOrigin;
function fail(res, err) {
  res.status(err.status || (err.code === 11000 ? 409 : 500)).json({ error: err.status ? err.message : err.code === 11000 ? "This attendee is already on a team." : "Could not update the team. Try again." });
}
async function view(team) {
  if (!team) return null;
  await team.populate("members", "name email");
  var project = await Project.findOne({ team: team._id }).select("name tableNumber room").populate("room", "name").lean();
  return { _id: team._id, name: team.name, members: team.members, invites: team.invites.map(function invite(i) { return { email: i.email, invitedAt: i.invitedAt }; }), lockedAt: team.lockedAt || null, project: project };
}
/** @param {object} req - Request with attendee QR or user id. @param {object} res - Response. @returns {Promise<void>} */
async function lookup(req, res) {
  try {
    var body = req.body || {};
    if (body.email && !body.qrId && !body.userId) {
      var user = await User.findOne({ email: String(body.email).trim().toLowerCase() }).select("_id");
      if (!user) return res.status(404).json({ error: "Attendee not found." });
      body = { userId: user._id };
    }
    var found = await resolveAttendee(body, { allowNotAccepted: true });
    if (found.error) return res.status(found.status).json({ error: found.error });
    res.json({ attendee: { id: found.user._id, name: found.user.name, email: found.user.email }, team: await view(await Team.findOne({ members: found.user._id })) });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Staff action request. @param {object} res - Response. @returns {Promise<void>} */
async function change(req, res) {
  try {
    var result = await control.locked(async function changeTeam() {
      if (!mongoose.isValidObjectId(req.params.id)) throw control.problem(404, "Team not found.");
      var team = await Team.findById(req.params.id);
      if (!team) throw control.problem(404, "Team not found.");
      var action = req.teamAction;
      var email = String((req.body || {}).email || req.params.email || "").trim().toLowerCase();
      var affected;
      var settings = await Settings.getSingleton();
      var max = settings.teamMaxSize || 4;
      if (action === "invite") {
        if (!validator.isEmail(email)) throw control.problem(400, "Enter a valid email address.");
        if (team.members.length + team.invites.length >= max) throw control.problem(400, "Team is full, counting pending invites.");
        if (team.invites.some(function same(i) { return i.email === email; }) || await User.exists({ _id: { $in: team.members }, email: email })) throw control.problem(409, "This attendee is already a member or invited.");
        team.invites.push({ email: email, invitedBy: req.user.id, invitedAt: new Date() });
      } else if (action === "cancelInvite") {
        if (!team.invites.some(function same(i) { return i.email === email; })) throw control.problem(404, "Invite not found.");
        team.invites = team.invites.filter(function keep(i) { return i.email !== email; });
      } else if (action === "add") {
        var found = await resolveAttendee(req.body);
        if (found.error) throw control.problem(found.status, found.error);
        if (found.user.role === "judge") throw control.problem(403, "Accepted participants only.");
        affected = found.user._id;
        email = found.user.email;
        if (await Team.exists({ members: affected })) throw control.problem(409, "This attendee is already on a team.");
        var invites = team.invites.filter(function keep(i) { return i.email !== email; });
        if (team.members.length + invites.length >= max) throw control.problem(400, "Team is full, counting pending invites.");
        team.invites = invites;
        team.members.push(affected);
      } else if (action === "remove") {
        affected = req.params.userId;
        if (!mongoose.isValidObjectId(affected) || !team.members.some(function same(id) { return String(id) === String(affected); })) throw control.problem(404, "Member not found.");
        team.members = team.members.filter(function keep(id) { return String(id) !== String(affected); });
        if (String(team.leader) === String(affected) && team.members.length) team.leader = team.members[0];
      }
      team.staffChanges.push({ by: req.user.id, at: new Date(), action: action, user: affected, email: email || undefined });
      // Keep an empty team for the audit and its checked-in project. Staff may
      // add a replacement without losing its table or lock.
      if (action === "add" && team.members.length === 1) team.leader = affected;
      await team.save();
      await Project.updateOne({ team: team._id }, { $set: { members: team.members } });
      if (affected) hardwareTeamChange(affected);
      if (action === "invite") {
        var staff = await User.findById(req.user.id).select("name");
        mailer.sendTemplateEmail(email, "team_invite", { inviterName: staff ? staff.name : "Event staff", teamName: team.name, teamsUrl: origin() + "/dashboard/team" }).catch(function failed(err) { console.error("Staff team invite:", err); });
      }
      return view(team);
    });
    res.json({ team: result });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function unlock(req, res) {
  try {
    await control.locked(async function clear() {
      if (!mongoose.isValidObjectId(req.params.id)) throw control.problem(404, "Team not found.");
      var team = await Team.findByIdAndUpdate(req.params.id, { $unset: { lockedAt: 1, lockedBy: 1 }, $push: { staffChanges: { by: req.user.id, at: new Date(), action: "unlock" } } }, { new: true });
      if (!team) throw control.problem(404, "Team not found.");
    });
    res.json({ unlocked: true });
  } catch (err) { fail(res, err); }
}
module.exports = { lookup: lookup, change: change, unlock: unlock };
