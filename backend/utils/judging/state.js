"use strict";
var crypto = require("crypto");
var State = require("../../schemas/judgingState");
var Settings = require("../../schemas/judgingSettings");

// A holder that dies mid-write releases the lock when its lease runs out, so
// a backend restart can never leave judging stuck. Writes take milliseconds.
var LEASE_MS = 15000;
var Assignment = require("../../schemas/judgingAssignment");
/** @param {number} status - HTTP status. @param {string} message - Public error. @returns {Error} Request error. */
function problem(status, message) { return Object.assign(new Error(message), { status: status }); }
/** @param {void} unused - No input. @returns {Promise<object>} Singleton. */
async function getState() {
  var state;
  try {
    state = await State.findOneAndUpdate({ _id: "judging" }, { $setOnInsert: { busyUntil: null } }, { upsert: true, new: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
    state = await State.findById("judging");
  }
  return withOpen(state);
}
/**
 * Attach the open/closed switch, which lives in JudgingSettings (opening it
 * also locks the rubric).
 * @param {object} state - JudgingState document.
 * @returns {Promise<object>} The same document with `judgingOpen` set.
 */
async function withOpen(state) {
  var settings = await Settings.getSingleton();
  state.judgingOpen = Boolean(settings.judgingOpen);
  return state;
}
/**
 * Run work while holding the judging lease, which serializes queue changes,
 * score writes and opening/closing across processes.
 * @param {function} work - Database work receiving the locked state.
 * @returns {Promise<*>} The work's result.
 */
async function locked(work) {
  await getState();
  var token = crypto.randomBytes(12).toString("hex");
  var state;
  for (var attempt = 0; attempt < 150; attempt++) {
    var now = new Date();
    state = await State.findOneAndUpdate(
      { _id: "judging", $or: [{ busyUntil: null }, { busyUntil: { $lt: now } }] },
      { $set: { busyUntil: new Date(now.getTime() + LEASE_MS), busyToken: token } },
      { new: true }
    );
    if (state) break;
    await new Promise(function pause(resolve) { setTimeout(resolve, 20); });
  }
  if (!state) throw problem(409, "Judging is busy. Retry this action.");
  try { return await work(await withOpen(state)); }
  finally { await State.updateOne({ _id: "judging", busyToken: token }, { $set: { busyUntil: null, busyToken: null } }); }
}
/** @param {object|string} judge - User id. @returns {Promise<void>} Remove from active queues. */
async function removeJudge(judge) {
  await locked(async function remove(state) {
    if (state.activeVersion) await Assignment.updateOne({ version: state.activeVersion }, { $pull: { queues: { judge: judge } } });
  });
}
/** @param {object|string} project - Project id. @param {object} state - Locked singleton. @returns {Promise<void>} Prune active queue entries without shifting slots. */
async function removeProject(project, state) {
  if (!state.activeVersion) return;
  await Assignment.updateOne({ version: state.activeVersion }, {
    $pull: { "queues.$[].projects": project, "queues.$[].skipped": project },
  });
  await Assignment.updateOne({ version: state.activeVersion }, {
    $set: { "queues.$[].slots.$[slot]": null },
  }, { arrayFilters: [{ slot: project }] });
}
module.exports = { getState: getState, locked: locked, problem: problem, removeJudge: removeJudge, removeProject: removeProject };
