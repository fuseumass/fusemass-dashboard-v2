"use strict";
var mongoose = require("mongoose");
/** @typedef {object} WorkshopAttempt
 * @property {object} user
 * @property {string} session - Workshop session secret fingerprint.
 * @property {number} wrong
 */
var schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, required: true },
    session: { type: String, required: true },
    wrong: { type: Number, default: 0 },
  },
  { timestamps: true },
);
schema.index({ user: 1, session: 1 }, { unique: true });
module.exports = mongoose.model("WorkshopAttempt", schema);
