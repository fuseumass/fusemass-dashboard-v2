"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * How the applicant is applying.
 * @typedef {"individual" | "group" | "team"} ApplicationType
 */

/**
 * Review status. Applications start "pending" and an admin moves them to
 * "accepted" or "rejected".
 * @typedef {"pending" | "accepted" | "rejected"} ApplicationStatus
 */

/**
 * @typedef {Object} ApplicationAttrs
 * @property {mongoose.Types.ObjectId} applicant - User who submitted the application.
 * @property {ApplicationType} type              - Individual, group, or team.
 * @property {mongoose.Types.ObjectId} [team]    - Team reference when type is "team".
 * @property {string[]} [groupMembers]           - Free-text member names/emails when type is "group".
 * @property {ApplicationStatus} status          - Review status.
 * @property {mongoose.Types.ObjectId} [reviewedBy] - Admin who made the decision.
 * @property {Date} [reviewedAt]                 - When the decision was made.
 */

var applicationSchema = new Schema(
  {
    applicant: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["individual", "group", "team"],
      required: true,
    },
    // Set when `type === "team"`.
    team: {
      type: Schema.Types.ObjectId,
      ref: "Team",
    },
    // Set when `type === "group"`: lightweight list of collaborators.
    groupMembers: [
      {
        type: String,
        trim: true,
      },
    ],
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
      index: true,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    reviewedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// One applicant may only have a single application in the system.
applicationSchema.index({ applicant: 1 }, { unique: true });

module.exports = mongoose.model("Application", applicationSchema);
