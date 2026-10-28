"use strict";
var mongoose = require("mongoose");
/** @typedef {object} WorkshopAttendance
 * @property {object} user
 * @property {object} workshop
 * @property {Date} checkedInAt
 * @property {string} method - code or staff.
 * @property {object} addedBy - Staff user, when supplied.
 */
var schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    workshop: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workshop",
      required: true,
    },
    checkedInAt: { type: Date, default: Date.now },
    method: { type: String, enum: ["code", "staff"], required: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);
schema.index({ user: 1, workshop: 1 }, { unique: true });
module.exports = mongoose.model("WorkshopAttendance", schema);
