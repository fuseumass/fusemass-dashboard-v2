"use strict";
var mongoose = require("mongoose");
/** @typedef {object} JudgingState
 * @property {string} _id - Singleton key.
 * @property {boolean} judgingOpen - Score writes allowed.
 * @property {number} activeVersion - Explicitly activated version.
 * @property {boolean} busy - Serializes queue changes, scores and freeze across processes.
 */
var schema = new mongoose.Schema({
  _id: { type: String, default: "judging" },
  judgingOpen: { type: Boolean, default: true },
  activeVersion: { type: Number, default: null },
  busy: { type: Boolean, default: false },
}, { timestamps: true });
module.exports = mongoose.model("JudgingState", schema);
