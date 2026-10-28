"use strict";

var mongoose = require("mongoose");
/**
 * Minimal judge profile, extended by B24d calibration later.
 * @typedef {object} JudgeProfile
 * @property {object} user - Unique User reference.
 * @property {boolean} hardware - Can judge hardware projects.
 * @property {boolean} calibrationDone - Finished calibration.
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
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
module.exports = mongoose.model("JudgeProfile", schema);
