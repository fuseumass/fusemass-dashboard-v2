"use strict";
var State = require("../../schemas/judgingState");
var Assignment = require("../../schemas/judgingAssignment");
/** @param {number} status - HTTP status. @param {string} message - Public error. @returns {Error} Request error. */
function problem(status, message) { return Object.assign(new Error(message), { status: status }); }
/** @param {void} unused - No input. @returns {Promise<object>} Singleton. */
async function getState() {
  try {
    return await State.findOneAndUpdate({ _id: "judging" }, { $setOnInsert: { judgingOpen: true } }, { upsert: true, new: true });
  } catch (err) {
    if (err.code === 11000) return State.findById("judging");
    throw err;
  }
}
/** @param {function} work - Database work receiving locked state. @returns {Promise<*>} Result.
 * A failed process deliberately leaves the lock held: operators must clear busy
 * after confirming it has stopped. Expiring a lease could admit overlapping writes.
 */
async function locked(work) {
  await getState();
  var state;
  for (var attempt = 0; attempt < 100; attempt++) {
    state = await State.findOneAndUpdate({ _id: "judging", busy: false }, { $set: { busy: true } }, { new: true });
    if (state) break;
    await new Promise(function pause(resolve) { setTimeout(resolve, 20); });
  }
  if (!state) throw problem(409, "Judging is busy. Retry this action.");
  try { return await work(state); }
  finally { await State.updateOne({ _id: "judging" }, { $set: { busy: false } }); }
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
