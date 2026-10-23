"use strict";

var mongoose = require("mongoose");

var Schema = mongoose.Schema;

/**
 * An application round / cycle. A hackathon can run several rounds (e.g. an
 * "Early Bird" round, then "General Admission", then "Waitlist"). Admins create
 * and open/close rounds from the admin dashboard; applicants submit against
 * whichever round is currently open.
 */

var applicationRoundSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    // Only one round should typically be open at a time, but we don't force it.
    isOpen: {
      type: Boolean,
      default: false,
    },
    opensAt: {
      type: Date,
    },
    closesAt: {
      type: Date,
    },
    // Controls display order in the admin dashboard.
    order: {
      type: Number,
      default: 0,
    },
    // Per-round application form customization, edited by admins (not
    // moderators). Left flexible on purpose — the form builder is a later task;
    // for now it holds arbitrary field definitions the frontend can interpret.
    // Example: [{ key, label, type, required, options }]
    formConfig: {
      type: Schema.Types.Mixed,
      default: function () {
        return [];
      },
    },
    // Settings for the built-in profile questions (name, phone, school, ...),
    // which aren't in formConfig: which ones are required, and replacement
    // choices for the education and gender selects. See utils/formConfig.
    // Example: { required: ["phone", "age"], options: { gender: ["Male", ...] } }
    profileFields: {
      type: Schema.Types.Mixed,
      default: function () {
        return {};
      },
    },
    // Waitlist mode (see utils/waitlist). Once this many applications in the
    // round are accepted, applications submitted from then on are waitlisted
    // automatically. null = no limit. Staff-only: applicants never get it
    // (the applicant routes send the round without it).
    waitlistAfterAccepted: {
      type: Number,
      min: 1,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ApplicationRound", applicationRoundSchema);
