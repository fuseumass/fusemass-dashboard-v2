"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * A team groups multiple applicants under one name. Applications made "as a
 * team" reference a Team document. The leader is the user who created it.
 *
 * @typedef {Object} TeamAttrs
 * @property {mongoose.Types.ObjectId} leader   - User who owns/created the team.
 * @property {string} name                      - Human-readable team name.
 * @property {mongoose.Types.ObjectId[]} members - Users on the team (includes the leader).
 */

var teamSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    leader: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    members: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Team", teamSchema);
