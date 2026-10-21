"use strict";

var mongoose = require("mongoose");

var applicationStatus = require("../utils/applicationStatus");

var Schema = mongoose.Schema;

/**
 * A hackathon application. Holds the full applicant profile collected by the
 * standard application form, plus review status. One application per applicant
 * per round.
 *
 * Review status starts "pending"; an admin moves it to "accepted"/"rejected"
 * (or "waitlisted"). While still being filled out it can be saved as "draft".
 */

// Sub-shape for the social links section. All optional.
var socialsSchema = new Schema(
  {
    linkedin: { type: String, trim: true, default: "" },
    github: { type: String, trim: true, default: "" },
    website: { type: String, trim: true, default: "" },
    // Any additional links the applicant wants to add, e.g. Devpost, Twitter.
    other: [
      {
        label: { type: String, trim: true },
        url: { type: String, trim: true },
      },
    ],
  },
  { _id: false }
);

// Prior hackathon experience.
var experienceSchema = new Schema(
  {
    attendedBefore: { type: Boolean, default: false },
    hackathonsAttended: { type: Number, default: 0, min: 0 },
    // Whether they've attended THIS hackathon (ORG_NAME) before.
    attendedThisBefore: { type: Boolean, default: false },
  },
  { _id: false }
);

var applicationSchema = new Schema(
  {
    applicant: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    round: {
      type: Schema.Types.ObjectId,
      ref: "ApplicationRound",
      index: true,
    },

    // ---- Personal ----------------------------------------------------------
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    age: { type: Number, min: 0 },
    gender: { type: String, trim: true },
    pronouns: { type: String, trim: true },

    // ---- Education ---------------------------------------------------------
    education: { type: String, trim: true }, // e.g. "Undergraduate", "High School"
    university: { type: String, trim: true }, // autofilled from colleges.csv
    major: { type: String, trim: true },

    // ---- Logistics ---------------------------------------------------------
    allergies: { type: String, trim: true, default: "" },
    tshirtSize: {
      type: String,
      enum: ["XS", "S", "M", "L", "XL", "XXL", "XXXL", ""],
      default: "",
    },
    // Name of the resume blob in the private Azure container. Never sent to
    // clients (see the toJSON transform below): the resume endpoints hand out
    // short-lived signed links after checking who is asking.
    resumeBlobName: { type: String, default: "" },

    // ---- Socials -----------------------------------------------------------
    socials: { type: socialsSchema, default: function () { return {}; } },

    // ---- Experience --------------------------------------------------------
    experience: { type: experienceSchema, default: function () { return {}; } },

    // ---- Skills ------------------------------------------------------------
    programmingSkills: [{ type: String, trim: true }],
    hardwareSkills: [{ type: String, trim: true }],
    otherSkills: [{ type: String, trim: true }],

    // ---- Dynamic per-round fields --------------------------------------------
    // Answers to the round's formConfig-defined fields, keyed by field `key`.
    // Kept flexible (Mixed) since formConfig itself is admin-editable.
    answers: {
      type: Schema.Types.Mixed,
      default: function () {
        return {};
      },
    },

    // ---- Review ------------------------------------------------------------
    status: {
      type: String,
      enum: applicationStatus.APPLICATION_STATUSES,
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

    // ---- Flags -------------------------------------------------------------
    // Reviewers' "look closer at this one" marker (see utils/applicationFlags).
    // Set by a moderator (with a reason, `flaggedBy` = them) or by the
    // automatic checks on submit (`flaggedBy` unset). Staff-only: left out of
    // the application JSON applicants get (see the toJSON transform below).
    flagged: { type: Boolean, default: false, index: true },
    flagReasons: [{ type: String, trim: true }],
    flaggedBy: { type: Schema.Types.ObjectId, ref: "User" },
    flaggedAt: { type: Date },

    // Fingerprints for spotting the same phone number / resume file on two
    // accounts: the phone's last 10 digits and the resume's SHA-256. Kept
    // whether or not automatic flagging is on, so turning it on later can
    // already compare against earlier applications. Never sent to clients.
    phoneKey: { type: String, index: true, sparse: true },
    resumeHash: { type: String, index: true, sparse: true },
  },
  { timestamps: true }
);

// One application per applicant per round.
applicationSchema.index({ applicant: 1, round: 1 }, { unique: true });

// Clients only need to know whether a resume exists; opening it goes through
// an access-checked signed link. `resumeUrl` is the permanent blob URL older
// builds stored — dropped so it can't leak from those documents either.
//
// Flags are for staff, so they are left out unless the caller asks with
// `application.toJSON({ includeFlags: true })`, which only the moderator
// routes do. Leaving them out by default means a route that returns an
// application to its applicant can't leak them by forgetting something.
applicationSchema.set("toJSON", {
  transform: function transform(_doc, ret, options) {
    ret.hasResume = Boolean(ret.resumeBlobName);
    delete ret.resumeBlobName;
    delete ret.resumeUrl;
    delete ret.phoneKey;
    delete ret.resumeHash;
    if (!(options && options.includeFlags)) {
      delete ret.flagged;
      delete ret.flagReasons;
      delete ret.flaggedBy;
      delete ret.flaggedAt;
    }
    return ret;
  },
});

module.exports = mongoose.model("Application", applicationSchema);
