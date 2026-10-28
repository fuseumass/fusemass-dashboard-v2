"use strict";
var mongoose = require("mongoose");
/** @typedef {object} JudgingState
 * @property {string} _id - Singleton key.
 * @property {number} activeVersion - Explicitly activated version.
 * @property {Date} busyUntil - Lease expiry for the lock that serializes queue
 *   changes, scores and freeze across processes; null when free.
 * @property {string} busyToken - Holder of the current lease.
 * The open/closed switch is JudgingSettings.judgingOpen.
 */
var schema = new mongoose.Schema({
  _id: { type: String, default: "judging" },
  activeVersion: { type: Number, default: null },
  busyUntil: { type: Date, default: null },
  busyToken: { type: String, default: null },
}, { timestamps: true });
module.exports = mongoose.model("JudgingState", schema);
