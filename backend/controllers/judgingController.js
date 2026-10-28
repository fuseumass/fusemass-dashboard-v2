"use strict";
var mongoose = require("mongoose");
var Assignment = require("../schemas/judgingAssignment");
var Score = require("../schemas/judgingScore");
var Project = require("../schemas/project");
var control = require("../utils/judging/state");
var getCriteria = require("../utils/judging/criteria").getCriteria;

function fail(res, err) {
  res.status(err.status || 500).json({ error: err.status ? err.message : "Could not update judging. Retry." });
}
async function context(state, judge) {
  var assignment = state.activeVersion ? await Assignment.findOne({ version: state.activeVersion }) : null;
  var queue = assignment && assignment.queues.find(function mine(q) { return String(q.judge) === String(judge); });
  var scores = await Score.find({ judge: judge }).lean();
  var done = new Set(scores.map(function id(s) { return String(s.project); }));
  var projects = queue ? await Project.find({ _id: { $in: queue.projects }, withdrawn: false }).select("name tableNumber room category devpostUrl hardware").populate({ path: "room", select: "name" }).lean() : [];
  var byId = new Map(projects.map(function entry(p) { return [String(p._id), p]; }));
  var ordered = queue ? queue.projects.map(function project(p) { return byId.get(String(p)); }).filter(Boolean) : [];
  var skipped = new Set(queue ? queue.skipped.map(String) : []);
  var current = ordered.find(function pending(p) { return !done.has(String(p._id)) && !skipped.has(String(p._id)); });
  return { assignment: assignment, queue: queue, scores: scores, done: done, skipped: skipped, ordered: ordered, current: current || null };
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function queue(req, res) {
  try {
    var state = await control.getState();
    var ctx = await context(state, req.user.id);
    var assignments = ctx.ordered.map(function entry(p, i) {
      var id = String(p._id);
      var score = ctx.scores.find(function same(s) { return String(s.project) === id; });
      return Object.assign({}, p, { position: i + 1, slot: ctx.queue.slots.findIndex(function same(s) { return String(s) === id; }) + 1,
        status: ctx.done.has(id) ? "done" : ctx.skipped.has(id) ? "skipped" : "upcoming",
        scores: score ? score.scores : null, comments: score ? score.comments : "" });
    });
    res.json({ judgingOpen: state.judgingOpen, version: state.activeVersion, criteria: await getCriteria(),
      slotMinutes: ctx.assignment ? ctx.assignment.params.slotMinutes : null,
      current: assignments.find(function same(p) { return ctx.current && String(p._id) === String(ctx.current._id); }) || null,
      total: assignments.length, assignments: assignments,
      skipped: assignments.filter(function skipped(p) { return p.status === "skipped"; }),
      done: assignments.filter(function done(p) { return p.status === "done"; }) });
  } catch (err) { fail(res, err); }
}
async function validate(body) {
  var criteria = await getCriteria();
  if (!body.scores || typeof body.scores !== "object" || Array.isArray(body.scores) ||
      Object.keys(body.scores).length !== criteria.length || criteria.some(function invalid(c) {
        var value = body.scores[c.key];
        return !Number.isInteger(value) || value < c.min || value > c.max;
      })) throw control.problem(400, "Provide an integer in range for every rubric criterion.");
  if (body.comments !== undefined && (typeof body.comments !== "string" || body.comments.length > 10000)) throw control.problem(400, "Comments must be text up to 10000 characters.");
}
async function writable(state, judge, projectId) {
  if (!state.judgingOpen) throw control.problem(409, "Judging is closed.");
  if (!mongoose.isValidObjectId(projectId) || !await Project.exists({ _id: projectId })) throw control.problem(404, "Project not found.");
  var ctx = await context(state, judge);
  if (!ctx.queue || !ctx.ordered.some(function same(p) { return String(p._id) === String(projectId); })) throw control.problem(403, "This project is not in your active queue.");
  return ctx;
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function scores(req, res) {
  try {
    var body = req.body || {};
    await control.locked(async function write(state) {
      var ctx = await writable(state, req.user.id, body.projectId);
      await validate(body);
      if ((!ctx.current || String(ctx.current._id) !== String(body.projectId)) && !ctx.skipped.has(String(body.projectId)) && !ctx.done.has(String(body.projectId))) throw control.problem(409, "Score the current project first.");
      await Score.findOneAndUpdate({ judge: req.user.id, project: body.projectId },
        { $set: { scores: body.scores, comments: body.comments || "" } }, { upsert: true, new: true, runValidators: true });
      // Progress is derived from scores and explicit skips, never a cursor.
      // Rescoring an earlier project cannot consume another queue entry.
      ctx.queue.skipped = ctx.queue.skipped.filter(function keep(p) { return String(p) !== String(body.projectId); });
      await ctx.assignment.save();
    });
    res.json({ saved: true });
  } catch (err) { fail(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function skip(req, res) {
  try {
    await control.locked(async function write(state) {
      var id = (req.body || {}).projectId;
      if (id === undefined) {
        if (!state.judgingOpen) throw control.problem(409, "Judging is closed.");
        var current = (await context(state, req.user.id)).current;
        if (!current) throw control.problem(409, "There is no current project to skip.");
        id = current._id;
      }
      var ctx = await writable(state, req.user.id, id);
      if (!ctx.current || String(ctx.current._id) !== String(id)) throw control.problem(409, "Only the current project can be skipped.");
      ctx.queue.skipped.addToSet(id);
      await ctx.assignment.save();
    });
    res.json({ skipped: true });
  } catch (err) { fail(res, err); }
}
module.exports = { queue: queue, scores: scores, skip: skip };
