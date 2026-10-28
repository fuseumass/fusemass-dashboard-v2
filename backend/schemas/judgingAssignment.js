"use strict";
var mongoose = require("mongoose");
var Schema = mongoose.Schema;
/** @typedef {object} JudgingAssignment
 * @property {number} version - Unique generation number.
 * @property {object} createdBy - Admin user id.
 * @property {object} params - Generation parameters.
 * @property {object[]} verifierReport - Per-pool verification reports.
 * @property {object[]} sheetLabels - Persistent anonymous ordinals for this version.
 * @property {object[]} queues - Judge user ids, ordered projects, slot gaps and skipped ids.
 */
var schema = new Schema({
  version: { type: Number, required: true, unique: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  params: { judgingsPerProject: Number, slotMinutes: { type: Number, default: null } },
  verifierReport: [Schema.Types.Mixed],
  sheetLabels: [{ _id: false, judge: { type: Schema.Types.ObjectId, ref: "User" }, label: String }],
  queues: [{ _id: false, judge: { type: Schema.Types.ObjectId, ref: "User" },
    projects: [{ type: Schema.Types.ObjectId, ref: "Project" }],
    slots: [{ type: Schema.Types.ObjectId, ref: "Project", default: null }],
    skipped: [{ type: Schema.Types.ObjectId, ref: "Project" }] }],
}, { timestamps: true });
module.exports = mongoose.model("JudgingAssignment", schema);
