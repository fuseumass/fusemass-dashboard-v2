"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * A hackathon team: people building one project together. Anyone with an
 * account can start one and invite others by email; the team saves its
 * Devpost project link, which is how judging (B24b) matches an imported
 * Devpost project to the dashboard team and its members.
 *
 * Integrity is enforced by unique indexes, not just checks, so concurrent
 * requests can't break it: a user is on at most one team (multikey index on
 * `members`), team names are unique ignoring case (`nameKey`), and a Devpost
 * project belongs to at most one team (`devpostUrl`, sparse).
 *
 * @typedef {object} TeamAttrs
 * @property {string} name - Display name.
 * @property {string} nameKey - Lowercased name, for uniqueness.
 * @property {mongoose.Types.ObjectId} leader - Can rename the team and remove members.
 * @property {mongoose.Types.ObjectId[]} members - Everyone on the team, leader included.
 * @property {Array<{email: string, invitedBy: mongoose.Types.ObjectId, invitedAt: Date}>} invites
 *   Pending invites, by email (the invitee may not have logged in yet).
 * @property {string} [devpostUrl] - Normalized https://devpost.com/software/<slug>.
 */

var inviteSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User" },
    invitedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

var teamSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    nameKey: { type: String, required: true, unique: true },
    leader: { type: Schema.Types.ObjectId, ref: "User", required: true },
    members: [{ type: Schema.Types.ObjectId, ref: "User" }],
    invites: {
      type: [inviteSchema],
      default: function () {
        return [];
      },
    },
    devpostUrl: { type: String, trim: true },
    devpostUpdatedAt: { type: Date },
  },
  { timestamps: true }
);

// One team per person; one team per Devpost project.
teamSchema.index({ members: 1 }, { unique: true });
teamSchema.index({ devpostUrl: 1 }, { unique: true, sparse: true });
// Finding the invites addressed to someone.
teamSchema.index({ "invites.email": 1 });

/**
 * The uniqueness key for a team name: trimmed, lowercased, inner spaces
 * collapsed ("Byte  Me" and "byte me" collide).
 * @param {string} name - Team name.
 * @returns {string}
 */
teamSchema.statics.nameKeyFor = function nameKeyFor(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
};

module.exports = mongoose.model("Team", teamSchema);
