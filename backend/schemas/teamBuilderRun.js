"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * One run of the admin team builder (POST /api/admin/team-builder/apply):
 * who ran it, when, and what it did to each team. Kept for audit; the teams
 * themselves also record each change in `Team.staffChanges`.
 *
 * @typedef {object} TeamBuilderRunAttrs
 * @property {mongoose.Types.ObjectId} by - Admin who ran it.
 * @property {mongoose.Types.ObjectId} [round] - Round the proposals came from.
 * @property {Array<string>} statuses - Application statuses in scope.
 * @property {object} totals - { created, merged, added, invited, skipped }.
 * @property {Array<TeamBuilderResult>} results - One per requested proposal.
 */

/**
 * @typedef {object} TeamBuilderResult
 * @property {string} action - "created" | "merged" | "skipped".
 * @property {mongoose.Types.ObjectId} [team] - Team created or merged into.
 * @property {string} teamName
 * @property {string} [reason] - Why the whole proposal was skipped.
 * @property {Array<string>} added - Emails added as members (leader included).
 * @property {Array<string>} invited - Emails invited.
 * @property {Array<{email: string, reason: string}>} skipped - People left alone.
 */

var resultSchema = new Schema(
  {
    action: { type: String, enum: ["created", "merged", "skipped"], required: true },
    team: { type: Schema.Types.ObjectId, ref: "Team" },
    teamName: { type: String, default: "" },
    reason: { type: String, default: "" },
    added: [{ type: String }],
    invited: [{ type: String }],
    skipped: [{ _id: false, email: String, reason: String }],
  },
  { _id: false }
);

var teamBuilderRunSchema = new Schema(
  {
    by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    round: { type: Schema.Types.ObjectId, ref: "ApplicationRound" },
    statuses: [{ type: String }],
    totals: {
      created: { type: Number, default: 0 },
      merged: { type: Number, default: 0 },
      added: { type: Number, default: 0 },
      invited: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    },
    results: { type: [resultSchema], default: undefined },
  },
  { timestamps: true }
);

teamBuilderRunSchema.index({ createdAt: -1 });

module.exports = mongoose.model("TeamBuilderRun", teamBuilderRunSchema);
