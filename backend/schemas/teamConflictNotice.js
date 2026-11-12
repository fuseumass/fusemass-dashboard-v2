"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * Records that the team builder told someone their teammate list conflicts
 * with another applicant's (the `team_conflict` email), so a re-run doesn't
 * send it again. `signature` identifies the lists involved: when they change
 * the person is told again.
 *
 * @typedef {object} TeamConflictNoticeAttrs
 * @property {mongoose.Types.ObjectId} user - The applicant who was emailed.
 * @property {mongoose.Types.ObjectId} round - Application round the lists came from.
 * @property {string} signature - Hash of the lists in the conflict.
 * @property {string} email - Address it was sent to.
 * @property {Date} sentAt - When it was queued.
 */
var teamConflictNoticeSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    round: { type: Schema.Types.ObjectId, ref: "ApplicationRound", required: true },
    signature: { type: String, required: true },
    email: { type: String, default: "" },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

teamConflictNoticeSchema.index({ user: 1, round: 1 }, { unique: true });

module.exports = mongoose.model("TeamConflictNotice", teamConflictNoticeSchema);
