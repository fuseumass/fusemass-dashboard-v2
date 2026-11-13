"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * A team staff suggested (imported on the Teams page) for people who asked for
 * help finding one. Nobody is on a team until they accept: the first person to
 * accept starts the real team (as its leader) and later accepters join it.
 *
 * @typedef {object} TeamSuggestion
 * @property {Array<{email: string, user: (mongoose.Types.ObjectId|null), name: string,
 *   status: string, respondedAt: (Date|null)}>} members - status is
 *   "pending", "accepted" or "declined".
 * @property {mongoose.Types.ObjectId|null} team - The team started by the first
 *   person to accept, or null while nobody has.
 * @property {mongoose.Types.ObjectId} createdBy - Admin who imported it.
 * @property {Date} createdAt
 */

var memberSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    user: { type: Schema.Types.ObjectId, ref: "User", default: null },
    name: { type: String, default: "", trim: true },
    status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending" },
    respondedAt: { type: Date, default: null },
  },
  { _id: false }
);

var teamSuggestionSchema = new Schema(
  {
    members: { type: [memberSchema], default: [] },
    team: { type: Schema.Types.ObjectId, ref: "Team", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// Finding the suggestions addressed to someone.
teamSuggestionSchema.index({ "members.email": 1 });

module.exports = mongoose.model("TeamSuggestion", teamSuggestionSchema);
