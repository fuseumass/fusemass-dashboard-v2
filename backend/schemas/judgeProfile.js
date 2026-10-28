"use strict";

var mongoose = require("mongoose");
/**
 * Judge calibration and assignment availability.
 * @typedef {object} JudgeProfile
 * @property {object} user - Unique User reference.
 * @property {boolean} hardware - Can judge hardware projects.
 * @property {boolean} calibrationDone - Finished calibration.
 * @property {Array<object>} calibrationScores - One score object per round.
 * @property {object|null} bias - Last computed general/category bias and timestamp.
 * @property {boolean} active - Available for assignments.
 */
var schema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    hardware: { type: Boolean, default: false },
    calibrationDone: { type: Boolean, default: false },
    calibrationScores: [
      {
        _id: false,
        round: { type: Number, required: true },
        scores: { type: mongoose.Schema.Types.Mixed, required: true },
        comments: { type: String, default: "" },
      },
    ],
    bias: {
      type: new mongoose.Schema(
        { general: Number, category: Number, computedAt: Date },
        { _id: false },
      ),
      default: null,
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, optimisticConcurrency: true },
);
module.exports = mongoose.model("JudgeProfile", schema);
