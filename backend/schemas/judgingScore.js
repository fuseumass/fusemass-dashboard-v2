"use strict";
var mongoose = require("mongoose");
/** @typedef {object} JudgingScore
 * @property {object} judge - Judge user id.
 * @property {object} project - Project id.
 * @property {object} scores - Integer values keyed by rubric criterion.
 * @property {string} comments - Judge's comments.
 */
var schema = new mongoose.Schema({
  judge: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
  scores: { type: Map, of: Number, required: true },
  comments: { type: String, default: "", maxlength: 10000 },
}, { timestamps: true });
schema.index({ judge: 1, project: 1 }, { unique: true });
module.exports = mongoose.model("JudgingScore", schema);
